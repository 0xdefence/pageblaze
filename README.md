# PageBlaze

Open-source crawler + SEO/visual monitoring platform.

## Current Status
Day 1 scaffold is in place:
- Fastify API (`apps/api`)
- BullMQ worker (`apps/worker`)
- Shared package (`packages/shared`)
- Infra compose (`infra/docker-compose.yml`)

## Monorepo Layout

```txt
PageBlaze/
  apps/
    api/
    worker/
  packages/
    shared/
  infra/
  PRD.md
```

## Features Implemented (Day 1)

### API
- `GET /healthz`
- `POST /v1/scrape`
- `POST /v1/crawl`
- `GET /v1/jobs/:id`
- API key auth via `x-api-key`

### Worker
- Queue processing with BullMQ
- `scrape` jobs:
  - HTTP fetch
  - Browser fallback (Playwright)
  - content extraction (Readability + Turndown)
- `crawl` jobs:
  - basic BFS crawl with depth/page limits

### Infra
- Redis
- Postgres
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
```

> If port `5432` is already used locally, change the host-side mapping in `infra/docker-compose.yml`.

## Run API

```bash
npm run dev:api
```

## Run Worker

```bash
npm run dev:worker
```

## Smoke Test

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

## Roadmap (Next)
- robots/sitemap awareness
- canonical/dedupe layer
- persistent document storage
- issue model + SEO checks
- visual snapshots + diffing

## Product PRD
- `PRD.md`
