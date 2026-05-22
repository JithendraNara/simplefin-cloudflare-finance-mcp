CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT,
  conn_id TEXT,
  conn_name TEXT,
  org_name TEXT,
  org_url TEXT,
  currency TEXT,
  balance REAL,
  available_balance REAL,
  balance_date INTEGER,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT,
  payee TEXT,
  memo TEXT,
  posted_at INTEGER,
  transacted_at INTEGER,
  pending INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_posted ON transactions(posted_at);
CREATE INDEX IF NOT EXISTS idx_transactions_transacted ON transactions(transacted_at);

CREATE TABLE IF NOT EXISTS transaction_enrichment (
  transaction_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  merchant_normalized TEXT NOT NULL,
  is_subscription_candidate INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  ai_reason TEXT,
  enriched_at TEXT NOT NULL,
  model TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transaction_enrichment_category ON transaction_enrichment(category);
CREATE INDEX IF NOT EXISTS idx_transaction_enrichment_merchant ON transaction_enrichment(merchant_normalized);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  account_count INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  errlist_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  trigger TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_synced_at ON sync_runs(synced_at);
CREATE INDEX IF NOT EXISTS idx_sync_runs_trigger ON sync_runs(trigger);

CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_briefings_period ON briefings(period_start, period_end, kind);

CREATE TABLE IF NOT EXISTS semantic_index_jobs (
  transaction_id TEXT PRIMARY KEY,
  indexed_at TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  vector_id TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage(created_at);
