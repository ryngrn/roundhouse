ALTER TABLE roundhouse.job_attempts ADD COLUMN IF NOT EXISTS node_id uuid;
ALTER TABLE roundhouse.job_attempts ADD COLUMN IF NOT EXISTS node_name text;
