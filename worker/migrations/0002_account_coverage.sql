CREATE TABLE IF NOT EXISTS account_sync_coverage (
  account_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_balance_date INTEGER,
  earliest_transaction_at INTEGER,
  latest_transaction_at INTEGER,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  last_incremental_sync_at TEXT,
  last_backfill_at TEXT,
  last_backfill_days INTEGER,
  coverage_status TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_sync_coverage_status
  ON account_sync_coverage(coverage_status);

CREATE INDEX IF NOT EXISTS idx_account_sync_coverage_updated
  ON account_sync_coverage(updated_at);

CREATE TABLE IF NOT EXISTS account_sync_events (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  event_type TEXT NOT NULL,
  event_at TEXT NOT NULL,
  sync_run_id TEXT,
  start_date TEXT,
  end_date TEXT,
  backfill_days INTEGER,
  transaction_count_before INTEGER,
  transaction_count_after INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_account_sync_events_account
  ON account_sync_events(account_id, event_at);

CREATE INDEX IF NOT EXISTS idx_account_sync_events_type
  ON account_sync_events(event_type, event_at);
