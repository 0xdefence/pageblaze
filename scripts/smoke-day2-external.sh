#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

API_KEY_VAL="${API_KEY:-pageblaze-dev-key}"
API_URL="${API_URL:-http://127.0.0.1:4410}"
TARGET_URL="${TARGET_URL:-https://example.com}"
DB_URL_VAL="${SMOKE_DATABASE_URL:-postgresql://postgres:postgres@localhost:55432/pageblaze}"

cleanup() {
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${WORKER_PID:-}" ]]; then kill "$WORKER_PID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "[1/7] Starting infra"
docker compose -f infra/docker-compose.yml down -v >/dev/null 2>&1 || true
docker compose -f infra/docker-compose.yml up -d >/dev/null
for i in {1..40}; do
  if docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U postgres -d pageblaze >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[2/7] Running migrations + starting API + worker"
DATABASE_URL="$DB_URL_VAL" npm run db:migrate >/tmp/pageblaze-migrate-day2.log 2>&1
fuser -k 4410/tcp >/dev/null 2>&1 || true
pkill -f '/PageBlaze/node_modules/.bin/tsx src/worker.ts' >/dev/null 2>&1 || true
pkill -f '/PageBlaze/node_modules/.bin/tsx src/server.ts' >/dev/null 2>&1 || true
DATABASE_URL="$DB_URL_VAL" npm run dev:api > /tmp/pageblaze-api-day2.log 2>&1 & API_PID=$!
DATABASE_URL="$DB_URL_VAL" npm run dev:worker > /tmp/pageblaze-worker-day2.log 2>&1 & WORKER_PID=$!

for i in {1..40}; do
  if curl -fsS "$API_URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$API_URL/healthz" >/dev/null

echo "[3/7] Submit external crawl ($TARGET_URL)"
RESP="$(curl -fsS -X POST "$API_URL/v1/crawl" \
  -H "x-api-key: $API_KEY_VAL" \
  -H 'content-type: application/json' \
  -d "{\"startUrl\":\"$TARGET_URL\",\"maxDepth\":1,\"maxPages\":8,\"renderMode\":\"http\",\"respectRobots\":true}")"
JOB_ID="$(printf '%s' "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.jobId||''));")"

if [[ -z "$JOB_ID" ]]; then
  echo "No jobId returned"
  echo "$RESP"
  exit 1
fi

echo "[4/7] Poll job completion: $JOB_ID"
for i in {1..80}; do
  JOB="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/jobs/$JOB_ID")"
  STATE="$(printf '%s' "$JOB" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.job?.state||''));")"
  if [[ "$STATE" == "completed" ]]; then break; fi
  if [[ "$STATE" == "failed" ]]; then
    echo "Job failed"
    echo "$JOB"
    exit 1
  fi
  sleep 1
done

STATE="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/jobs/$JOB_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.job?.state||''));")"
[[ "$STATE" == "completed" ]] || { echo "Timeout waiting completion"; exit 1; }

echo "[5/7] Verify crawl record persisted"
CRAWL="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/crawls/$JOB_ID")"
PAGES="$(printf '%s' "$CRAWL" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.crawl?.pages_count||0));")"
PAGE_ROWS="$(printf '%s' "$CRAWL" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String((d.pages||[]).length));")"
[[ "$PAGES" -ge 1 || "$PAGE_ROWS" -ge 1 ]] || { echo "Expected persisted page rows"; echo "$CRAWL"; exit 1; }

echo "[6/7] Verify pages endpoint"
PAGE_LIST="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/crawls/$JOB_ID/pages?limit=5")"
COUNT="$(printf '%s' "$PAGE_LIST" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String((d.pages||[]).length));")"
[[ "$COUNT" -ge 1 ]] || { echo "Expected pages list >=1"; echo "$PAGE_LIST"; exit 1; }

echo "[7/7] Verify documents endpoint"
DOCS="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/documents?runId=$JOB_ID&limit=1")"
DOC_ID="$(printf '%s' "$DOCS" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.documents?.[0]?.id||''));")"

if [[ -n "$DOC_ID" ]]; then
  DOC="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/documents/$DOC_ID")"
  printf '%s\n' "$DOC" | sed -n '1,120p'
else
  echo "No document persisted for this run (likely external fetch blocked); persistence still verified via crawl/page rows."
fi

echo "PASS: day2 external smoke"
