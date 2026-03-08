#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== PageBlaze Day14 Demo Prep =="

echo "[1] install + build"
npm install >/dev/null
npm run build >/dev/null

echo "[2] migrate"
npm run db:migrate >/dev/null

echo "[3] core smoke checks"
npm run smoke:day1 >/dev/null
npm run smoke:day6 >/dev/null

echo "[4] run services"
echo "Start these in separate terminals:"
echo "  npm run dev:api"
echo "  npm run dev:worker"
echo "  npm run dev:web"

echo "[5] demo route order"
echo "  1) Overview KPIs + Top Fixes"
echo "  2) Issues filter"
echo "  3) Recommendations sort"
echo "  4) Visual diffs"
echo "  5) Alerts endpoints + test"

echo "Done."
