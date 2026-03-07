CREATE TABLE IF NOT EXISTS alert_endpoints (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT REFERENCES crawl_runs(id) ON DELETE SET NULL,
  endpoint_id BIGINT REFERENCES alert_endpoints(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_endpoints_kind_enabled ON alert_endpoints(kind, enabled);
CREATE INDEX IF NOT EXISTS idx_alert_events_status_created ON alert_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_run_created ON alert_events(run_id, created_at DESC);
