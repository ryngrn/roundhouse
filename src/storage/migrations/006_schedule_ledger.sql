-- Durable scheduler receipts only. Nothing in this migration starts a worker.
CREATE TABLE IF NOT EXISTS roundhouse.schedules (
  id uuid PRIMARY KEY,
  schedule_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('control_plane_wake', 'health_check')),
  interval_minutes integer NOT NULL CHECK (interval_minutes BETWEEN 5 AND 10080),
  next_due_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS schedules_due_idx
  ON roundhouse.schedules (next_due_at, id) WHERE enabled;

-- The key is the schedule identity plus its exact UTC due instant.
-- It is intentionally independent of node identity and worker restarts.
CREATE TABLE IF NOT EXISTS roundhouse.schedule_occurrences (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES roundhouse.schedules(id),
  scheduled_for timestamptz NOT NULL,
  schedule_revision bigint NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'completed', 'failed')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (schedule_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS schedule_occurrences_status_idx
  ON roundhouse.schedule_occurrences (status, recorded_at, id);
