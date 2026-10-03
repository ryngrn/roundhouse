CREATE TABLE IF NOT EXISTS roundhouse.remote_commands (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  claimed_by uuid REFERENCES roundhouse.nodes(id),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS remote_commands_queue_idx
  ON roundhouse.remote_commands (status, created_at, id);
