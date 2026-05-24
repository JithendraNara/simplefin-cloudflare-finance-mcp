ALTER TABLE eval_labels
  ADD COLUMN split TEXT NOT NULL DEFAULT 'train';

ALTER TABLE eval_labels
  ADD COLUMN split_assigned_at TEXT;

ALTER TABLE eval_labels
  ADD COLUMN split_assigned_by TEXT;

UPDATE eval_labels
SET split = COALESCE(NULLIF(split, ''), 'train'),
    split_assigned_at = COALESCE(split_assigned_at, labeled_at),
    split_assigned_by = COALESCE(split_assigned_by, labeled_by, 'migration')
WHERE split IS NULL
   OR split = ''
   OR split_assigned_at IS NULL
   OR split_assigned_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_eval_labels_split
  ON eval_labels(split);

CREATE INDEX IF NOT EXISTS idx_eval_labels_split_category
  ON eval_labels(split, correct_category);
