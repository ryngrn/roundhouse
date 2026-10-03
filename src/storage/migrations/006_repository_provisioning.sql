CREATE TABLE IF NOT EXISTS roundhouse.repository_records (
  id text PRIMARY KEY,
  adapter_id text NOT NULL,
  provider_repository_id text NOT NULL,
  lifecycle_state text NOT NULL,
  revision bigint NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (adapter_id, provider_repository_id)
);

CREATE TABLE IF NOT EXISTS roundhouse.repository_actions (
  id text PRIMARY KEY,
  repository_id text REFERENCES roundhouse.repository_records(id) ON DELETE SET NULL,
  adapter_id text NOT NULL,
  action_kind text NOT NULL,
  status text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_digest text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS repository_actions_reconcile_idx
  ON roundhouse.repository_actions (status, started_at);

CREATE TABLE IF NOT EXISTS roundhouse.repository_workspace_mappings (
  id text PRIMARY KEY,
  repository_id text NOT NULL REFERENCES roundhouse.repository_records(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL,
  workspace text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS repository_workspace_active_idx
  ON roundhouse.repository_workspace_mappings (repository_id, project_id, purpose, status);
