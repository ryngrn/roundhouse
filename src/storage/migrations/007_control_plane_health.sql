CREATE TABLE IF NOT EXISTS roundhouse.control_plane_health (
  check_name text PRIMARY KEY,
  last_success_at timestamptz NOT NULL
);
