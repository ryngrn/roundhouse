import pg from "pg";

const { Pool } = pg;

export const RELAY_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS roundhouse_relay;

CREATE TABLE IF NOT EXISTS roundhouse_relay.dashboard_projection (
  id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS roundhouse_relay.remote_commands (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','completed','failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS remote_commands_queue_idx
  ON roundhouse_relay.remote_commands (status, created_at, id);
`;

function tlsFor(connectionString, allowInsecure = false, ca = null) {
  const url = new URL(connectionString);
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return false;
  if (ca) return { rejectUnauthorized: true, ca };
  if (allowInsecure || url.searchParams.get("sslmode") === "require") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

export class PostgresRelay {
  constructor({ pool }) {
    this.pool = pool;
    this.ensurePromise = null;
  }

  static create({ connectionString, allowInsecure = false, ca = null, pool } = {}) {
    if (pool) return new PostgresRelay({ pool });
    if (!connectionString) throw new Error("ROUNDHOUSE_RELAY_DATABASE_URL is required.");
    const parsed = new URL(connectionString);
    const tls = tlsFor(connectionString, allowInsecure, ca);
    parsed.searchParams.delete("sslmode");
    parsed.searchParams.delete("uselibpqcompat");
    return new PostgresRelay({ pool: new Pool({
      connectionString: parsed.toString(),
      ssl: tls,
      max: 1,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000,
      application_name: "roundhouse:relay",
    }) });
  }

  async ensure() {
    if (!this.ensurePromise) {
      this.ensurePromise = this.pool.query(RELAY_SCHEMA).catch((error) => {
        this.ensurePromise = null;
        throw error;
      });
    }
    await this.ensurePromise;
  }

  async publishProjection(payload) {
    await this.ensure();
    const result = await this.pool.query(`
      INSERT INTO roundhouse_relay.dashboard_projection(id,revision,updated_at,payload)
      VALUES ('current',1,clock_timestamp(),$1)
      ON CONFLICT (id) DO UPDATE
      SET revision=roundhouse_relay.dashboard_projection.revision+1,
          updated_at=clock_timestamp(),
          payload=EXCLUDED.payload
      RETURNING revision,updated_at
    `, [payload]);
    return result.rows[0];
  }

  async readProjection() {
    await this.ensure();
    const result = await this.pool.query(`
      SELECT revision,updated_at,payload
      FROM roundhouse_relay.dashboard_projection
      WHERE id='current'
    `);
    return result.rows[0] ?? null;
  }

  async claimRemoteCommand() {
    await this.ensure();
    const result = await this.pool.query(`
      WITH candidate AS (
        SELECT id FROM roundhouse_relay.remote_commands
        WHERE status='queued'
        ORDER BY created_at,id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE roundhouse_relay.remote_commands command
      SET status='processing',claimed_at=clock_timestamp()
      FROM candidate
      WHERE command.id=candidate.id
      RETURNING command.id,command.kind,command.payload
    `);
    return result.rows[0] ?? null;
  }

  async finishRemoteCommand(id, { result, error } = {}) {
    await this.ensure();
    const status = error ? "failed" : "completed";
    await this.pool.query(`
      UPDATE roundhouse_relay.remote_commands
      SET status=$2,result=$3,error=$4,finished_at=clock_timestamp()
      WHERE id=$1
    `, [id, status, result ?? null, error ?? null]);
  }

  async close() {
    await this.pool.end();
  }
}

export class RelayProjectionPublisher {
  constructor({ relay, project, onError = () => {} }) {
    this.relay = relay;
    this.project = project;
    this.onError = onError;
    this.pending = false;
    this.running = null;
    this.stopped = false;
  }

  trigger() {
    if (!this.relay || this.stopped) return Promise.resolve();
    this.pending = true;
    if (!this.running) {
      this.running = Promise.resolve().then(async () => {
        while (this.pending && !this.stopped) {
          this.pending = false;
          await this.relay.publishProjection(await this.project());
        }
      }).catch((error) => this.onError(error)).finally(() => {
        this.running = null;
        if (this.pending && !this.stopped) this.trigger();
      });
    }
    return this.running;
  }

  stop() {
    this.stopped = true;
    this.pending = false;
  }
}

export function openPostgresRelay({ env = process.env, connectionString, allowInsecure = false } = {}) {
  const url = connectionString ?? env.ROUNDHOUSE_RELAY_DATABASE_URL;
  const ca = env.ROUNDHOUSE_RELAY_CA_CERT?.replaceAll("\\n", "\n") ?? null;
  return url ? PostgresRelay.create({ connectionString: url, allowInsecure, ca }) : null;
}
