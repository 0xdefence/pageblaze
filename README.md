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
- `GET /v1/stats`
- `GET /v1/metrics`
- `GET /v1/issues`
- `GET /v1/issues/groups`
- `GET /v1/recommendations`
- `GET /v1/recommendations/top`
- `GET /v1/trends/issues`
- `GET /v1/trends/recommendations`
- `GET /v1/visual/snapshots`
- `GET /v1/visual/diffs`
- `GET /v1/export/issues.csv`
- `GET /v1/export/recommendations.csv`
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

### Query optimization + counters + contracts (Day 2 Block 6)
- Added DB indexes for run status/type sorting and page/document lookup paths
- Added status counters and total pagination metadata in list endpoints
- Added `GET /v1/stats` aggregate counters endpoint
- Added response contracts under `docs/contracts/`

### SEO issues extraction (Day 3 Block 1)
- Added persisted `seo_issues` table with dedupe key `(run_id, url_hash, code)`
- Worker now extracts baseline technical SEO issues per scraped page (title/meta/H1/canonical/noindex/schema/alt)
- Added `GET /v1/issues` endpoint with filtering, pagination, and severity/code counters

### Recommendation scoring (Day 3 Block 2)
- Added persisted `recommendations` table linked to `seo_issues`
- Priority scoring model: `impact × confidence × (1 - effort)`
- Action recommendations generated per SEO issue code
- Added `GET /v1/recommendations` endpoint with filters + pagination + counters

### Analytics + top fixes (Day 3 Block 3/4)
- Added `GET /v1/recommendations/top` for ranked "fix this first" cards
- Added `GET /v1/issues/groups` to cluster noisy issues by code/severity
- Added trend endpoints:
  - `GET /v1/trends/issues`
  - `GET /v1/trends/recommendations`

### Visual diff scaffold (Day 4)
- Added persisted `visual_snapshots` + `visual_diffs`
- Content-hash snapshotting for each document
- Token-similarity diff scoring (`diff_score`) with changed flag
- Added visual query endpoints:
  - `GET /v1/visual/snapshots`
  - `GET /v1/visual/diffs`

### Day 5 enhancements (export + enhanced visual mode)
- Optional screenshot-assisted visual mode (`VISUAL_SCREENSHOT_ENABLED=true`) with desktop/mobile capture paths and hashes
- Visual diff scoring now can include screenshot hash drift signal
- Added CSV export endpoints:
  - `GET /v1/export/issues.csv`
  - `GET /v1/export/recommendations.csv`

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

External + persistence smoke (Day 2):

```bash
npm run smoke:day2
```

This validates external crawl execution and persisted records via `/v1/crawls/:id`, `/v1/crawls/:id/pages`, and `/v1/documents`.

Analytics smoke (Day 3):

```bash
npm run smoke:day3
```

This validates deterministic issue extraction, recommendation generation, and analytics endpoints (`/v1/issues`, `/v1/recommendations`, `/v1/recommendations/top`, `/v1/issues/groups`, trend endpoints, `/v1/stats`).

Visual smoke (Day 4):

```bash
npm run smoke:day4
```

This validates snapshot/diff persistence and visual endpoints (`/v1/visual/snapshots`, `/v1/visual/diffs`, `/v1/stats`).

Exports smoke (Day 5):

```bash
npm run smoke:day5
```

This validates CSV exports and visual endpoint continuity.

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
