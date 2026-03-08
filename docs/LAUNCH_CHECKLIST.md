# PageBlaze Launch Checklist (Day 14)

## Product readiness
- [ ] Overview, Issues, Recommendations, Visual, Alerts tabs reviewed
- [ ] Dark/Light mode visual QA complete
- [ ] Empty/error/loading states validated

## Backend readiness
- [ ] `npm run db:migrate` applied in target env
- [ ] `/healthz`, `/livez`, `/readyz` green
- [ ] `/v1/metrics` healthy (dbPingMs + queue backlog acceptable)

## Alerts readiness
- [ ] At least one webhook endpoint configured
- [ ] `POST /v1/alerts/test` succeeds
- [ ] `GET /v1/alerts/events` shows sent events

## Data quality
- [ ] Crawl -> issues -> recommendations flow validated on 3 sample domains
- [ ] Visual diff events appear for repeated snapshots
- [ ] Exports (`/v1/export/issues.csv`, `/v1/export/recommendations.csv`) validated

## CI/ops
- [ ] GitHub Actions `pageblaze-ci` passing
- [ ] `npm run contracts:check` passing locally
- [ ] Smoke scripts pass:
  - [ ] `npm run smoke:day1`
  - [ ] `npm run smoke:day6`
  - [ ] `npm run smoke:day5`

## Demo
- [ ] Run `scripts/demo-day14.sh`
- [ ] Record 60-90s demo walkthrough
- [ ] Capture screenshots for Overview/Issues/Recommendations/Visual/Alerts

## Post-launch watch
- [ ] Monitor `/v1/metrics` every 15 min first 2h
- [ ] Replay any failed alerts (`POST /v1/alerts/retry/:eventId`)
- [ ] Track top issue codes + top fixes trend daily
