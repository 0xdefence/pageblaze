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
  if [[ -n "${HOOK_PID:-}" ]]; then kill "$HOOK_PID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# local webhook receiver
cat > /tmp/pageblaze-hook.js <<'JS'
const http = require('http');
const fs = require('fs');
const port = 4499;
const out = '/tmp/pageblaze-hook-events.jsonl';
http.createServer((req,res)=>{
  let b='';
  req.on('data',c=>b+=c);
  req.on('end',()=>{ fs.appendFileSync(out, b+'\n'); res.statusCode=200; res.end('ok'); });
}).listen(port,'127.0.0.1');
JS
: > /tmp/pageblaze-hook-events.jsonl
node /tmp/pageblaze-hook.js >/tmp/pageblaze-hook.log 2>&1 & HOOK_PID=$!

echo "[1/6] Fresh infra"
docker compose -f infra/docker-compose.yml down -v >/dev/null 2>&1 || true
docker compose -f infra/docker-compose.yml up -d >/dev/null
for i in {1..40}; do
  if docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U postgres -d pageblaze >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "[2/6] Migrate + start services"
DATABASE_URL="$DB_URL_VAL" npm run db:migrate >/tmp/pageblaze-migrate-day6.log 2>&1
fuser -k 4410/tcp >/dev/null 2>&1 || true
pkill -f '/PageBlaze/node_modules/.bin/tsx src/worker.ts' >/dev/null 2>&1 || true
pkill -f '/PageBlaze/node_modules/.bin/tsx src/server.ts' >/dev/null 2>&1 || true
DATABASE_URL="$DB_URL_VAL" ALERT_PRIORITY_THRESHOLD=0.01 npm run dev:api >/tmp/pageblaze-api-day6.log 2>&1 & API_PID=$!
DATABASE_URL="$DB_URL_VAL" ALERT_PRIORITY_THRESHOLD=0.01 npm run dev:worker >/tmp/pageblaze-worker-day6.log 2>&1 & WORKER_PID=$!
for i in {1..40}; do
  if curl -fsS "$API_URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "[3/6] Register webhook endpoint"
EP=$(curl -fsS -X POST "$API_URL/v1/alerts/endpoints" -H "x-api-key: $API_KEY_VAL" -H 'content-type: application/json' -d '{"kind":"webhook","url":"http://127.0.0.1:4499/hook","enabled":true,"metadata":{"name":"local-test"}}')
echo "$EP" | sed -n '1,80p'

echo "[4/6] Trigger scrape to create alerts"
RESP=$(curl -fsS -X POST "$API_URL/v1/scrape" -H "x-api-key: $API_KEY_VAL" -H 'content-type: application/json' -d '{"url":"http://127.0.0.1:4410/healthz","renderMode":"http"}')
RUN_ID=$(echo "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.jobId||''));")
for i in {1..50}; do
  S=$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/jobs/$RUN_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d.job?.state||''));")
  [[ "$S" == "completed" ]] && break
  sleep 1
done
sleep 2

echo "[5/6] Verify alert events persisted"
EV=$(curl -fsS -H "x-api-key: $API_KEY_VAL" "$API_URL/v1/alerts/events?runId=$RUN_ID&limit=20")
CNT=$(echo "$EV" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String((d.events||[]).length));")
[[ "$CNT" -ge 1 ]] || { echo "expected alert events"; echo "$EV"; exit 1; }

echo "[6/6] Verify webhook receiver got payload"
LINES=$(wc -l < /tmp/pageblaze-hook-events.jsonl | tr -d ' ')
[[ "$LINES" -ge 1 ]] || { echo "expected webhook hits"; cat /tmp/pageblaze-hook.log; exit 1; }

echo "PASS: day6 alerts"
