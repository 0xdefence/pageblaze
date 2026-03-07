CREATE TABLE IF NOT EXISTS crawl_runs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  start_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  pages_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crawl_pages (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  normalized_url TEXT,
  url_hash TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, url)
);

CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  normalized_url TEXT,
  url_hash TEXT,
  title TEXT,
  excerpt TEXT,
  markdown TEXT,
  text_content TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seo_issues (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  document_id BIGINT REFERENCES documents(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  normalized_url TEXT,
  url_hash TEXT,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recommendations (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  issue_id BIGINT REFERENCES seo_issues(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  action TEXT NOT NULL,
  impact_score REAL NOT NULL,
  confidence_score REAL NOT NULL,
  effort_score REAL NOT NULL,
  priority_score REAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS visual_snapshots (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  document_id BIGINT REFERENCES documents(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL DEFAULT 'content',
  content_hash TEXT,
  image_path TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS visual_diffs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  snapshot_id BIGINT REFERENCES visual_snapshots(id) ON DELETE CASCADE,
  previous_snapshot_id BIGINT REFERENCES visual_snapshots(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  diff_score REAL NOT NULL,
  changed BOOLEAN NOT NULL,
  summary TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE crawl_pages ADD COLUMN IF NOT EXISTS normalized_url TEXT;
ALTER TABLE crawl_pages ADD COLUMN IF NOT EXISTS url_hash TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS normalized_url TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS url_hash TEXT;
ALTER TABLE seo_issues ADD COLUMN IF NOT EXISTS normalized_url TEXT;
ALTER TABLE seo_issues ADD COLUMN IF NOT EXISTS url_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_crawl_pages_run_normurl ON crawl_pages(run_id, normalized_url);
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_run_hash ON documents(run_id, url_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_seo_issues_run_hash_code ON seo_issues(run_id, url_hash, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recommendations_run_issue ON recommendations(run_id, issue_id);

CREATE INDEX IF NOT EXISTS idx_crawl_runs_created_at ON crawl_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_status_created_at ON crawl_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_type_created_at ON crawl_runs(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawl_pages_run_id ON crawl_pages(run_id);
CREATE INDEX IF NOT EXISTS idx_crawl_pages_run_status_id ON crawl_pages(run_id, status, id);
CREATE INDEX IF NOT EXISTS idx_documents_run_id ON documents(run_id);
CREATE INDEX IF NOT EXISTS idx_documents_run_created_id ON documents(run_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_documents_url_hash ON documents(url_hash);
CREATE INDEX IF NOT EXISTS idx_seo_issues_run_id ON seo_issues(run_id);
CREATE INDEX IF NOT EXISTS idx_seo_issues_severity_created ON seo_issues(severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_issues_code_created ON seo_issues(code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_run_priority ON recommendations(run_id, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_code_priority ON recommendations(code, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_visual_snapshots_urlhash_created ON visual_snapshots(url_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visual_snapshots_run_id ON visual_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_visual_diffs_run_score ON visual_diffs(run_id, diff_score DESC);
CREATE INDEX IF NOT EXISTS idx_visual_diffs_urlhash_created ON visual_diffs(url_hash, created_at DESC);
