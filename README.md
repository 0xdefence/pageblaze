# PageBlaze

Open-source crawler + SEO/visual monitoring platform.

## Current Status
Day 1 scaffold + hardening pass is in place:
- Fastify API (`apps/api`)
- BullMQ worker (`apps/worker`)
- Shared package (`packages/shared`)
- Infra compose (`infra/docker-compose.yml`)
- Deterministic smoke test (`scripts/smoke-day1.sh`)

## Monorepo Layout

```txt
PageBlaze/
  apps/
    api/
    worker/
  packages/
    shared/
  infra/
  scripts/
  PRD.md
```

## Features Implemented (Day 1 + Day 2 Block 1)

### API
- `GET /healthz`
- `POST /v1/scrape`
- `POST /v1/crawl`
- `GET /v1/jobs/:id`
- `GET /v1/crawls`
- `GET /v1/crawls/:id`
- `GET /v1/crawls/:id/pages`
- `GET /v1/documents`
- `GET /v1/documents/:id`
- API key auth via `x-api-key`
- Structured validation errors (400)
- Queue retries/backoff/timeouts

### Worker
- Queue processing with BullMQ
- `scrape` jobs:
  - HTTP fetch
  - optional browser fallback (Playwright, via `BROWSER_ENABLED=true`)
  - content extraction (Readability + Turndown)
- `crawl` jobs:
  - basic BFS crawl with depth/page limits
- graceful shutdown handlers

### Persistence (Day 2 Block 1)
- Postgres schema auto-init on API/worker start
- Tables:
  - `crawl_runs`
  - `crawl_pages`
  - `documents`
- Job lifecycle persisted (`queued` → `running` → `done/failed`)
- Scrape/crawl outputs stored as queryable documents/pages

### Normalization + dedupe (Day 2 Block 2)
- URL normalization (lowercase host, strip hash, remove tracking params, sort query params)
- URL hashing (`sha256`) for stable dedupe keys
- De-dupe in crawl queue by normalized URL
- DB-level dedupe:
  - unique `(run_id, normalized_url)` for pages
  - unique `(run_id, url_hash)` for documents

### Robots + sitemap awareness (Day 2 Block 3)
- `robots.txt` parsing for `User-agent: *` + `Disallow`
- Crawl-time robots enforcement (`respectRobots=true`)
- `sitemap.xml` seeding (from robots `Sitemap:` or fallback `/<host>/sitemap.xml`)
- Crawl result now includes robots/sitemap stats

### Read/query endpoints (Day 2 Block 4)
- Crawl run listing with filters + pagination
- Crawl pages listing endpoint with status filter + pagination
- Documents listing endpoint with `runId` filter + pagination

### Infra
- Redis
- Postgres (host port `55432`)
- MinIO

## Requirements
- Node.js 20+
- Docker + Docker Compose

## Setup

```bash
cp .env.example .env
npm install
```

## Run Infra

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
```

## Run API

```bash
npm run dev:api
```

## Run Worker

```bash
npm run dev:worker
```

## Smoke Test (recommended)

```bash
npm run smoke:day1
```

This script boots infra, starts API+worker, submits a scrape job, and fails fast if the job does not complete.

## Manual Test

Create scrape job:

```bash
curl -X POST http://localhost:4410/v1/scrape \
  -H 'x-api-key: pageblaze-dev-key' \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","renderMode":"auto","extract":"markdown"}'
```

Check job status:

```bash
curl -H 'x-api-key: pageblaze-dev-key' \
  http://localhost:4410/v1/jobs/<jobId>
```

## Environment

See `.env.example`:
- `PORT`
- `REDIS_URL`
- `DATABASE_URL`
- `MINIO_ENDPOINT`
- `MINIO_PORT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_BUCKET`
- `API_KEY`

Optional:
- `BROWSER_ENABLED` (`false` by default)

## Roadmap (Next)
- robots/sitemap awareness
- canonical/dedupe layer
- persistent document storage
- issue model + SEO checks
- visual snapshots + diffing

## Product PRD
- `PRD.md`

---

Signature: 🔥
