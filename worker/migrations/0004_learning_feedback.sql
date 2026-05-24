CREATE TABLE IF NOT EXISTS user_corrections (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  corrected_at TEXT NOT NULL,
  corrected_by TEXT,
  field_corrected TEXT NOT NULL,
  value_before TEXT,
  value_after TEXT,
  signal_text TEXT NOT NULL,
  note TEXT,
  superseded_by TEXT,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (superseded_by) REFERENCES user_corrections(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_corrections_transaction
  ON user_corrections(transaction_id, corrected_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_corrections_corrected_at
  ON user_corrections(corrected_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_corrections_field_value
  ON user_corrections(field_corrected, value_after);

CREATE TABLE IF NOT EXISTS eval_labels (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  correct_category TEXT NOT NULL,
  correct_merchant_normalized TEXT NOT NULL,
  correct_is_subscription INTEGER NOT NULL,
  labeled_at TEXT NOT NULL,
  labeled_by TEXT,
  notes TEXT,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_eval_labels_labeled_at
  ON eval_labels(labeled_at DESC);

CREATE INDEX IF NOT EXISTS idx_eval_labels_category
  ON eval_labels(correct_category);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  label_count INTEGER NOT NULL,
  results_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_started_at
  ON eval_runs(started_at DESC);
