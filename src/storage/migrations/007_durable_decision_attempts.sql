-- Cloud-native decision attempts are fenced receipts, not long-lived leases.
-- The AI call happens outside the DB transaction and can finish on any node.
-- Each item has at most one active attempt. Expiry quarantines; it never replays.
CREATE TABLE IF NOT EXISTS roundhouse.decision_attempts (
  id uuid PRIMARY KEY,
  -- Retain attempt audit even if a superseded item later gets tombstoned.
  item_id text NOT NULL,
  owner_node_id uuid NOT NULL,
  token uuid NOT NULL,
  start_revision bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('running','completed','failed','interrupted')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  result_state text,
  CHECK (deadline_at > started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS decision_attempts_one_running_idx
  ON roundhouse.decision_attempts (item_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS decision_attempts_due_idx
  ON roundhouse.decision_attempts (deadline_at, item_id) WHERE status='running';
