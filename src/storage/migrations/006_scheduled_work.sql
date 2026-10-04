ALTER TABLE roundhouse.jobs ADD COLUMN IF NOT EXISTS wait_kind text;
ALTER TABLE roundhouse.jobs ADD COLUMN IF NOT EXISTS eligible_at timestamptz;
ALTER TABLE roundhouse.jobs ADD COLUMN IF NOT EXISTS occurrence_key text;

ALTER TABLE roundhouse.jobs DROP CONSTRAINT IF EXISTS jobs_wait_kind_check;
ALTER TABLE roundhouse.jobs ADD CONSTRAINT jobs_wait_kind_check
  CHECK (wait_kind IS NULL OR wait_kind IN ('time', 'condition'));

CREATE UNIQUE INDEX IF NOT EXISTS jobs_occurrence_key_unique
  ON roundhouse.jobs (occurrence_key) WHERE occurrence_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_scheduled_eligibility_idx
  ON roundhouse.jobs (state, eligible_at, project_id, position, id);
