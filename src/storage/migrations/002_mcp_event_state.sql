CREATE TABLE IF NOT EXISTS roundhouse.mcp_event_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
