CREATE TABLE IF NOT EXISTS operational_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  path TEXT,
  method TEXT,
  operation TEXT,
  auth_type TEXT,
  is_admin INTEGER,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_operational_events_created_at
  ON operational_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operational_events_type_created_at
  ON operational_events(event_type, created_at DESC);
