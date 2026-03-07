#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

API_KEY_VAL="${API_KEY:-pageblaze-dev-key}"
API_URL="${API_URL:-http://127.0.0.1:4410}"
DB_URL_VAL="${SMOKE_DATABASE_URL:-postgresql://postgres:postgres@localhost:55432/pageblaze}"

cleanup() {
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${WORKER_PID:-}" ]]; then kill "$WORKER_PID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "[1/6] Fresh infra"
docker compose -f infra/docker-compose.yml down -v >/dev/null 2>&1 || true
docker compose -f infra/docker-compose.yml up -d >/dev/null
for i in {1..40}; do
  if docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U postgres -d pageblaze >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[2/6] Run migrations + start API+worker"
DATABASE_URL="$DB_URL_VAL" npm run db:migrate >/tmp/pageblaze-migrate-day3.log 2>&1
fuser -k 4410/tcp >/dev/null 2>&1 || true
pkill -f '/PageBlaze/node_modules/.bin/tsx src/worker.ts' >/dev/null 2>&1 || true
pkill -f '/PageBlaze/node_modules/.bin/tsx src/server.ts' >/dev/null 2>&1 || true
DATABASE_URL="$DB_URL_VAL" npm run dev:api > /tmp/pageblaze-api-day3.log 2>&1 & API_PID=$!
DATABASE_URL="$DB_URL_VAL" npm run dev:worker > /tmp/pageblaze-worker-day3.log 2>&1 & WORKER_PID=$!
for i in {1..40}; do
  if curl -fsS "$API_URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "[3/6] Submit deterministic scrape"
RESP="$(curl -fsS -X POST "$API_URL/v1/scrape" -H "x-api-key: $API_KEY_VAL" -H 'content-type: application/json' -d '{"url":"http://127.0.0.1:4410/healthz","renderMode":"http"}')"
JOB_ID="$(printf '%s' "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.jobId||''));")"
for i in {1..40}; do
  S="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/jobs/$JOB_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.job?.state||''));")"
  [[ "$S" == "completed" ]] && break
  [[ "$S" == "failed" ]] && { echo "job failed"; exit 1; }
  sleep 1
done

echo "[4/6] Verify issues + recommendations"
ISS="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/issues?runId=$JOB_ID&limit=5")"
IC="$(printf '%s' "$ISS" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String((d.issues||[]).length));")"
[[ "$IC" -ge 1 ]] || { echo "expected issues"; echo "$ISS"; exit 1; }

REC="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/recommendations?runId=$JOB_ID&limit=5")"
RC="$(printf '%s' "$REC" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String((d.recommendations||[]).length));")"
[[ "$RC" -ge 1 ]] || { echo "expected recommendations"; echo "$REC"; exit 1; }

echo "[5/6] Verify top/trends/groups"
TOP="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/recommendations/top?runId=$JOB_ID&limit=3")"
TC="$(printf '%s' "$TOP" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String((d.topFixes||[]).length));")"
[[ "$TC" -ge 1 ]] || { echo "expected top fixes"; exit 1; }

curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/issues/groups?runId=$JOB_ID&limit=3" >/dev/null
curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/trends/issues?runId=$JOB_ID" >/dev/null
curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/trends/recommendations?runId=$JOB_ID" >/dev/null

echo "[6/6] Stats sanity"
ST="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/stats")"
printf '%s\n' "$ST" | sed -n '1,120p'

echo "PASS: day3 analytics smoke"
