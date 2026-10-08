CREATE TABLE IF NOT EXISTS roundhouse.execution_outcomes (
  job_id text PRIMARY KEY REFERENCES roundhouse.jobs(id) ON DELETE CASCADE,
  classification text NOT NULL CHECK (classification IN (
    'native_success', 'recovered_success', 'exception_success', 'failed_or_abandoned'
  )),
  historical_import boolean NOT NULL DEFAULT false,
  exception_reason_code text CHECK (exception_reason_code IS NULL OR exception_reason_code IN (
    'stale_worker', 'missing_capability', 'provider_limit', 'herdr_failure',
    'remote_completion_evidence_missing', 'repository_lock', 'credential_config_gap',
    'unsupported_action', 'human_only_action', 'control_plane_bug', 'other'
  )),
  exception_reason_note text,
  exception_expected boolean,
  human_intervention_required boolean NOT NULL,
  human_intervention_count integer NOT NULL CHECK (human_intervention_count >= 0),
  human_minutes double precision CHECK (human_minutes IS NULL OR human_minutes >= 0),
  recorded_at timestamptz NOT NULL,
  recorded_by text NOT NULL,
  execution_path jsonb NOT NULL,
  provenance jsonb NOT NULL,
  evidence_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL,
  CHECK (jsonb_typeof(execution_path) = 'array' AND jsonb_array_length(execution_path) > 0),
  CHECK (jsonb_typeof(provenance) = 'object'),
  CHECK (jsonb_typeof(evidence_links) = 'array'),
  CHECK (human_intervention_required = (human_intervention_count > 0)),
  CHECK ((classification = 'exception_success') = (exception_expected IS NOT NULL)),
  CHECK (classification <> 'native_success' OR (
    historical_import = false
    AND human_intervention_required = false
    AND exception_reason_code IS NULL
    AND provenance ?& ARRAY['intake','dispatch','executor_ownership','verification','delivery']
  )),
  CHECK (classification = 'native_success' OR (
    exception_reason_code IS NOT NULL AND COALESCE(length(btrim(exception_reason_note)), 0) > 0
  ))
);

CREATE INDEX IF NOT EXISTS execution_outcomes_metrics_idx
  ON roundhouse.execution_outcomes (historical_import, classification, recorded_at);
