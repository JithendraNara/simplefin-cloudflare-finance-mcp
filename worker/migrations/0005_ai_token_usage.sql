CREATE TABLE IF NOT EXISTS ai_token_usage (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  task TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_token_usage_created_at
  ON ai_token_usage(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_token_usage_task_created_at
  ON ai_token_usage(task, created_at DESC);
