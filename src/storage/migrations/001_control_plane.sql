CREATE SCHEMA IF NOT EXISTS roundhouse;

CREATE TABLE IF NOT EXISTS roundhouse.schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS roundhouse.system_metadata (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS roundhouse.projects (
  id text PRIMARY KEY,
  name text,
  status text,
  last_commit text,
  stopped boolean NOT NULL DEFAULT false,
  blocked boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS roundhouse.project_candidates (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  executable boolean NOT NULL DEFAULT false,
  source_system text,
  record_count integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS roundhouse.depot_items (
  id text PRIMARY KEY,
  state text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  project_id text,
  project_candidate_id text,
  priority_rank integer,
  execution_eligible boolean NOT NULL DEFAULT true,
  requires_reevaluation boolean NOT NULL DEFAULT false,
  input_text text NOT NULL,
  input_source text,
  input_actor text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS depot_items_state_priority_idx
  ON roundhouse.depot_items (state, priority_rank NULLS LAST, created_at, id);

CREATE TABLE IF NOT EXISTS roundhouse.depot_item_revisions (
  item_id text NOT NULL,
  revision bigint NOT NULL,
  state text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL,
  PRIMARY KEY (item_id, revision)
);

CREATE TABLE IF NOT EXISTS roundhouse.decisions (
  id text PRIMARY KEY,
  item_id text NOT NULL REFERENCES roundhouse.depot_items(id) ON DELETE CASCADE,
  item_revision bigint NOT NULL,
  decision_key text,
  disposition text,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS decisions_item_idx ON roundhouse.decisions (item_id, created_at);

CREATE TABLE IF NOT EXISTS roundhouse.questions (
  id text PRIMARY KEY,
  item_id text NOT NULL REFERENCES roundhouse.depot_items(id) ON DELETE CASCADE,
  decision_id text,
  decision_key text,
  item_revision bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  kind text NOT NULL,
  prompt text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS questions_open_idx ON roundhouse.questions (status, item_id);

CREATE TABLE IF NOT EXISTS roundhouse.answers (
  question_id text PRIMARY KEY REFERENCES roundhouse.questions(id) ON DELETE CASCADE,
  text text NOT NULL,
  actor text NOT NULL,
  answered_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS roundhouse.jobs (
  id text PRIMARY KEY,
  item_id text NOT NULL REFERENCES roundhouse.depot_items(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  state text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  position bigint NOT NULL DEFAULT 0,
  agent_role text NOT NULL DEFAULT 'general',
  policy_hash text,
  delivery_intent jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  owning_node_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON roundhouse.jobs (state, project_id, position, id);

CREATE TABLE IF NOT EXISTS roundhouse.job_dependencies (
  job_id text NOT NULL REFERENCES roundhouse.jobs(id) ON DELETE CASCADE,
  depends_on_job_id text NOT NULL,
  PRIMARY KEY (job_id, depends_on_job_id)
);

CREATE TABLE IF NOT EXISTS roundhouse.job_attempts (
  job_id text NOT NULL REFERENCES roundhouse.jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  node_id uuid,
  node_name text,
  failure text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS roundhouse.agent_role_refs (
  job_id text PRIMARY KEY REFERENCES roundhouse.jobs(id) ON DELETE CASCADE,
  role_id text NOT NULL,
  profile_hash text,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS roundhouse.execution_metadata (
  job_id text NOT NULL REFERENCES roundhouse.jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  command jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  exit_code integer,
  passed boolean,
  timed_out boolean,
  overflow boolean,
  report jsonb,
  PRIMARY KEY (job_id, attempt_number),
  FOREIGN KEY (job_id, attempt_number) REFERENCES roundhouse.job_attempts(job_id, attempt_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS roundhouse.verification_results (
  job_id text NOT NULL,
  attempt_number integer NOT NULL,
  commit text,
  verified_at timestamptz,
  passed boolean NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (job_id, attempt_number),
  FOREIGN KEY (job_id, attempt_number) REFERENCES roundhouse.job_attempts(job_id, attempt_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS roundhouse.verification_checks (
  job_id text NOT NULL,
  attempt_number integer NOT NULL,
  check_index integer NOT NULL,
  check_id text NOT NULL,
  source text,
  passed boolean NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (job_id, attempt_number, check_index),
  FOREIGN KEY (job_id, attempt_number) REFERENCES roundhouse.job_attempts(job_id, attempt_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS roundhouse.shipping_records (
  job_id text PRIMARY KEY REFERENCES roundhouse.jobs(id) ON DELETE CASCADE,
  commit text,
  branch text,
  pushed boolean,
  shipped_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS roundhouse.deployments (
  job_id text PRIMARY KEY REFERENCES roundhouse.jobs(id) ON DELETE CASCADE,
  provider text,
  environment text,
  revision text,
  status text,
  url text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS roundhouse.transition_audit (
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  revision bigint NOT NULL,
  from_state text,
  to_state text NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision)
);

CREATE TABLE IF NOT EXISTS roundhouse.outbox_events (
  id text PRIMARY KEY,
  sequence bigint GENERATED BY DEFAULT AS IDENTITY UNIQUE,
  entity_id text NOT NULL,
  item_id text NOT NULL,
  source text,
  state text NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  question_id text,
  question_revision bigint,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS outbox_sequence_idx ON roundhouse.outbox_events (sequence);

CREATE TABLE IF NOT EXISTS roundhouse.mcp_subscriptions (
  id text PRIMARY KEY,
  owner text NOT NULL,
  active boolean NOT NULL,
  next_outbox_index bigint NOT NULL DEFAULT 0,
  refresh_before timestamptz,
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS roundhouse.mcp_deliveries (
  id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES roundhouse.mcp_subscriptions(id) ON DELETE CASCADE,
  outbox_id text NOT NULL REFERENCES roundhouse.outbox_events(id) ON DELETE CASCADE,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  lease_until timestamptz,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (subscription_id, outbox_id)
);
CREATE INDEX IF NOT EXISTS mcp_delivery_claim_idx ON roundhouse.mcp_deliveries (status, next_attempt_at, lease_until);

CREATE TABLE IF NOT EXISTS roundhouse.nodes (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  capabilities text[] NOT NULL DEFAULT '{}',
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS roundhouse.resource_leases (
  resource_kind text NOT NULL,
  resource_key text NOT NULL,
  owner_node_id uuid NOT NULL REFERENCES roundhouse.nodes(id),
  token uuid NOT NULL,
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (resource_kind, resource_key),
  CHECK (expires_at > acquired_at)
);
CREATE INDEX IF NOT EXISTS resource_leases_expiry_idx ON roundhouse.resource_leases (expires_at);

CREATE TABLE IF NOT EXISTS roundhouse.import_provenance (
  item_id text NOT NULL REFERENCES roundhouse.depot_items(id) ON DELETE CASCADE,
  source_system text NOT NULL,
  source_id text NOT NULL,
  source_page_url text,
  source_record_digest text,
  export_digest text,
  imported_at timestamptz NOT NULL,
  reconciled boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (item_id, source_system, source_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS import_provenance_source_idx
  ON roundhouse.import_provenance (source_system, source_id);
