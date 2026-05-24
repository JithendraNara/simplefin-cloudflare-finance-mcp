ALTER TABLE transaction_enrichment
  ADD COLUMN enrichment_source TEXT NOT NULL DEFAULT 'workers_ai';

ALTER TABLE transaction_enrichment
  ADD COLUMN prior_enrichment_json TEXT;

ALTER TABLE transaction_enrichment
  ADD COLUMN last_minimax_review_at TEXT;

ALTER TABLE transaction_enrichment
  ADD COLUMN minimax_review_status TEXT;

ALTER TABLE transaction_enrichment
  ADD COLUMN manual_review_suggested INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_transaction_enrichment_minimax_review
  ON transaction_enrichment(confidence, last_minimax_review_at);

CREATE INDEX IF NOT EXISTS idx_transaction_enrichment_source
  ON transaction_enrichment(enrichment_source);

ALTER TABLE user_corrections
  ADD COLUMN correction_rule_text TEXT;

ALTER TABLE user_corrections
  ADD COLUMN correction_rule_generated_at TEXT;

ALTER TABLE user_corrections
  ADD COLUMN correction_rule_model TEXT;
