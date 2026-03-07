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

echo "[1/5] Fresh infra"
docker compose -f infra/docker-compose.yml down -v >/dev/null 2>&1 || true
docker compose -f infra/docker-compose.yml up -d >/dev/null
for i in {1..40}; do
  if docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U postgres -d pageblaze >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "[2/5] Run migrations + start API+worker"
DATABASE_URL="$DB_URL_VAL" npm run db:migrate >/tmp/pageblaze-migrate-day5.log 2>&1
fuser -k 4410/tcp >/dev/null 2>&1 || true
pkill -f '/PageBlaze/node_modules/.bin/tsx src/worker.ts' >/dev/null 2>&1 || true
pkill -f '/PageBlaze/node_modules/.bin/tsx src/server.ts' >/dev/null 2>&1 || true
DATABASE_URL="$DB_URL_VAL" npm run dev:api > /tmp/pageblaze-api-day5.log 2>&1 & API_PID=$!
DATABASE_URL="$DB_URL_VAL" npm run dev:worker > /tmp/pageblaze-worker-day5.log 2>&1 & WORKER_PID=$!
for i in {1..40}; do
  if curl -fsS "$API_URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "[3/5] Seed deterministic scrape"
RESP="$(curl -fsS -X POST "$API_URL/v1/scrape" -H "x-api-key: $API_KEY_VAL" -H 'content-type: application/json' -d '{"url":"http://127.0.0.1:4410/healthz","renderMode":"http"}')"
RUN_ID="$(printf '%s' "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.jobId||''));")"
for i in {1..40}; do
  S="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/jobs/$RUN_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.job?.state||''));")"
  [[ "$S" == "completed" ]] && break
  sleep 1
done

echo "[4/5] Verify CSV exports"
ISS_CSV="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/export/issues.csv?runId=$RUN_ID")"
REC_CSV="$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/export/recommendations.csv?runId=$RUN_ID")"
printf '%s' "$ISS_CSV" | head -n 2
printf '%s' "$REC_CSV" | head -n 2
[[ "$ISS_CSV" == id,* ]] || { echo "issues csv missing header"; exit 1; }
[[ "$REC_CSV" == id,* ]] || { echo "recs csv missing header"; exit 1; }

echo "[5/5] Verify visual endpoints still healthy"
curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/visual/snapshots?runId=$RUN_ID&limit=5" >/dev/null
curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/visual/diffs?runId=$RUN_ID&limit=5" >/dev/null

echo "PASS: day5 exports + visual mode"
