# PageBlaze Deploy Runbook (Day 12)

## 1) Prerequisites
- Docker + Docker Compose
- Node.js 20+
- Postgres reachable from API/worker

## 2) Environment
Set required env:
- `API_KEY`
- `REDIS_URL`
- `DATABASE_URL`
- `BROWSER_ENABLED` (optional)
- `VISUAL_SCREENSHOT_ENABLED` (optional)
- `ALERT_PRIORITY_THRESHOLD`
- `ALERT_DIFF_THRESHOLD`

## 3) Bootstrap
```bash
npm install
npm run db:migrate
docker compose -f infra/docker-compose.yml up -d
```

## 4) Start services
```bash
npm run dev:api
npm run dev:worker
npm run dev:web
```

## 5) Health checks
- `GET /healthz`
- `GET /livez`
- `GET /readyz`
- `GET /v1/metrics`

## 6) Smoke checks
```bash
npm run smoke:day1
npm run smoke:day6
```

## 7) Incident quick actions
- Alert delivery issues:
  - check `/v1/alerts/events?status=failed`
  - replay via `POST /v1/alerts/retry/:eventId`
- Queue backlog:
  - inspect `/v1/metrics` queue.crawl / queue.alerts
- DB readiness:
  - verify `/readyz` and `dbPingMs` in `/v1/metrics`
