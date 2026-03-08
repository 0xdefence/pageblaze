# PageBlaze — PRD (v1)

## 1) Product Summary
**PageBlaze** helps web developers and growth teams crawl websites, detect SEO/visual issues, and prioritize fixes that improve traffic and conversion.

**Tagline:** Crawl. See. Rank.

---

## 2) Problem
Teams currently stitch together crawlers, Lighthouse, SEO audits, and screenshot tools manually.  
This creates:
- fragmented workflows
- delayed issue detection
- no clear fix prioritization

They need one system that says:
1) what changed,
2) what’s broken,
3) what to fix first.

---

## 3) Goals (v1)
1. Run reliable crawl/scrape jobs on modern sites.
2. Produce actionable SEO + visual diagnostics.
3. Prioritize issues by business impact.
4. Alert teams quickly via webhook/chat.
5. Be self-hostable and API-first.
6. Introduce brand/vibe extraction outputs (colors, visual elements, feel tags) as a productized visual intelligence layer.

### Non-goals (v1)
- full enterprise role/permission system
- keyword rank tracking at SERP scale
- advanced AI content generation

---

## 4) Target Users
### Primary ICP
- Web dev agencies
- In-house growth/SEO teams

### Secondary
- PMM/content teams at startups
- technical founders doing SEO in-house

---

## 5) JTBD
- “When my site changes, tell me if SEO or layout broke.”
- “When I launch a page, show top fixes before traffic is wasted.”
- “When competitors update content, alert me.”

---

## 6) Core User Stories
1. As a user, I can submit a domain crawl with constraints.
2. I can view crawl progress and failures.
3. I can see technical SEO issues per URL.
4. I can compare current vs previous screenshots.
5. I can view prioritized recommendations.
6. I can receive alerts when critical issues appear.
7. I can export issues for handoff to dev/SEO teams.

---

## 7) v1 Feature Requirements

## A) Crawl & Scrape
- `POST /v1/scrape`
- `POST /v1/crawl`
- `GET /v1/jobs/:id`
- domain allowlist, max depth/pages, render mode
- retries + fail reasons logged

**Acceptance:** 95%+ successful fetch/extract on representative sample.

## B) SEO Audit Engine (Top 20 checks)
Minimum checks:
- title missing/duplicate/length
- meta description missing/length
- canonical missing/self mismatch
- robots/noindex flags
- H1 missing/multiple
- heading hierarchy anomalies
- broken internal links
- image alt missing
- schema presence
- indexability issues

**Acceptance:** issue schema stored with severity + URL + evidence.

## C) Visual Monitoring
- capture desktop + mobile screenshots
- compare against previous baseline
- output visual diff score + changed regions
- extract brand/vibe profile signals:
  - dominant color palette + contrast profile
  - typography/style consistency hints
  - media inventory (images/GIF/video)
  - layout density / whitespace proxy
  - vibe tags (e.g. minimal, corporate, playful, aggressive)

**Acceptance:** detect major hero/nav/layout changes with low false negatives.

### C.1) Brand Profile Output (v1.1 extension)
Return a `brand_profile` object per page/site summary:
- `palette`: top colors + percentages
- `vibe_tags`: ranked tags with confidence
- `visual_consistency_score`: 0..1
- `media_mix`: image/gif/video counts
- `style_flags`: notable visual shifts vs baseline

## D) Prioritization Engine
Score formula:
`Priority = Impact × Confidence × EffortInverse`

Issue fields:
- severity (`critical/high/medium/low`)
- impact estimate (traffic/revenue proxy)
- confidence
- recommended action

**Acceptance:** top-10 “Fix first” list per crawl.

## E) Alerts & Export
- webhook notifications
- Slack/Telegram (at least one in v1)
- CSV/JSON export of issues/recommendations

**Acceptance:** alert triggers within 2 minutes of job completion.

---

## 8) UX / Information Architecture (v1)
Pages:
1. **Overview**: health score, trend, latest crawl summary
2. **Crawls**: job list, status, logs
3. **SEO Issues**: filterable issue table
4. **Visual Diffs**: before/after gallery
5. **Recommendations**: ranked fixes
6. **Settings**: domains, alerts, API keys

---

## 9) API Surface (v1)
- `POST /v1/scrape`
- `POST /v1/crawl`
- `GET /v1/jobs/:id`
- `GET /v1/issues?domain=&severity=`
- `GET /v1/recommendations?domain=`
- `GET /v1/visual-diffs?domain=`
- `GET /v1/brand-profile?domain=&url=` (planned)
- `POST /v1/alerts/test`

---

## 10) Data Model (high-level)
- `workspaces`
- `sites`
- `jobs`
- `job_urls`
- `documents`
- `seo_issues`
- `visual_snapshots`
- `visual_diffs`
- `recommendations`
- `alert_endpoints`
- `events`

---

## 11) Metrics / KPIs
### Product KPIs
- weekly active crawls/workspace
- issue resolution rate
- time-to-first-fix after alert

### System KPIs
- crawl success rate
- avg job duration
- extraction quality pass rate
- visual diff false-positive rate

---

## 12) Risks & Mitigations
1. **JS-heavy site failures**
   - fallback browser renderer + retries
2. **False-positive visual diffs**
   - threshold tuning + region masking
3. **Too many noisy issues**
   - severity scoring + recommendation clustering
4. **Rate-limit/anti-bot blocking**
   - per-domain throttles + adaptive backoff

---

## 13) Launch Plan
### Internal alpha (week 1–2)
- 5–10 test domains
- fix extraction and issue quality

### Private beta (week 3–4)
- 10 agencies/growth teams
- collect issue usefulness feedback

### Public beta
- self-serve onboarding
- docs + demo + templates

---

## 14) v1 Exit Criteria (Definition of Done)
- Crawl + scrape stable in production
- SEO checks generate trustworthy issues
- Visual diff works on top 20 templates
- Recommendations are understandable/actionable
- Alerts and exports functional
- Dashboard usable end-to-end without CLI
