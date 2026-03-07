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

echo "[1/5] Starting infra"
docker compose -f infra/docker-compose.yml down -v >/dev/null 2>&1 || true
docker compose -f infra/docker-compose.yml up -d >/dev/null
for i in {1..40}; do
  if docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U postgres -d pageblaze >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[2/5] Starting API + worker"
fuser -k 4410/tcp >/dev/null 2>&1 || true
DATABASE_URL="$DB_URL_VAL" npm run dev:api > /tmp/pageblaze-api.log 2>&1 & API_PID=$!
DATABASE_URL="$DB_URL_VAL" npm run dev:worker > /tmp/pageblaze-worker.log 2>&1 & WORKER_PID=$!

for i in {1..30}; do
  if curl -fsS "$API_URL/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "$API_URL/healthz" >/dev/null

echo "[3/5] Submitting scrape job"
RESP="$(curl -fsS -X POST "$API_URL/v1/scrape" \
  -H "x-api-key: $API_KEY_VAL" \
  -H "content-type: application/json" \
  -d '{"url":"http://127.0.0.1:4410/healthz","renderMode":"http","extract":"markdown"}')"
JOB_ID="$(printf '%s' "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.jobId||''));")"

if [[ -z "$JOB_ID" ]]; then
  echo "No jobId returned"
  echo "$RESP"
  exit 1
fi

echo "[4/5] Polling job: $JOB_ID"
for i in {1..40}; do
  JOB="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/jobs/$JOB_ID")"
  STATE="$(printf '%s' "$JOB" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.job?.state||''));")"
  if [[ "$STATE" == "completed" ]]; then
    echo "[5/5] PASS: scrape completed"
    printf '%s
' "$JOB" | sed -n '1,120p'
    exit 0
  elif [[ "$STATE" == "failed" ]]; then
    echo "[5/5] FAIL: scrape job failed"
    printf '%s
' "$JOB" | sed -n '1,120p'
    exit 1
  fi
  sleep 1
done

echo "[5/5] FAIL: timeout waiting for completion"
exit 1
