ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS dedupe_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_events_dedupe_hash ON alert_events(dedupe_hash);
