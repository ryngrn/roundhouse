# PostgreSQL authoritative control plane

Roundhouse uses PostgreSQL as the authoritative shared control plane whenever
`DATABASE_URL` is present. Neon is the intended hosted provider, but the schema and
queries use standard PostgreSQL. The local `state.json` repository remains an
explicit single-node development/test/bootstrap option; it is not a cache, replica,
or write-behind backup for PostgreSQL.

## Configuration and security

Set only the connection URL in the service environment:

```sh
export DATABASE_URL='postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require'
```

Non-loopback connections require certificate-validated TLS. Keep the URL in the
process/service secret store, never in project configuration, PostgreSQL rows, log
files, or committed files. PostgreSQL contains workflow metadata and operational
evidence, not executor/provider credentials. Node identity is a generated UUID in
the private Roundhouse state directory; `ROUNDHOUSE_NODE_NAME` and the optional
comma-separated `ROUNDHOUSE_NODE_CAPABILITIES` only describe the installation.

Startup applies forward-only, transactional migrations under a PostgreSQL advisory
lock. A migration version is recorded only after its transaction succeeds. Deploy
application versions in schema-compatible order and take a backup before upgrading;
do not edit an already-applied migration.

## Native cutover from `state.json`

Do not set `DATABASE_URL` on the live Studio service until a real database exists,
is backed up, and the import has been verified. Stop the local worker, then run:

```sh
DATABASE_URL='postgresql://…?sslmode=require' \
  node src/cli.js migrate state-to-postgres \
  --state-dir "$HOME/Library/Application Support/Roundhouse/state"
```

The command refuses to run without credentials, creates a mode-0600 timestamped
`state.before-postgres.*.json` backup, imports the normalized records, and verifies
item/job counts. IDs, histories, the shipped Inclusion job, Notion provenance, and
all imported pending records are preserved. Import records `execution_started:
false`; it neither runs the worker nor makes imported work eligible. It refuses to
replace a PostgreSQL control plane that already contains work.

After comparing `depot status` and `/health` against the local snapshot, configure
the service's real `DATABASE_URL` and restart it once. Keep the JSON backup for
audit/recovery, but do not resume JSON writes after cutover.

The macOS installer deliberately does not copy a connection URL from the shell into
a plist. Its service wrapper optionally loads
`~/Library/Application Support/Roundhouse/neon.env`, provided the file is a regular
file owned by the service user with mode `0400` or `0600`. The wrapper exports the
pooled `DATABASE_URL`, removes `DATABASE_URL_UNPOOLED` and `NEON_BRANCH`, and then
executes the service. `neon env pull --service postgres --file <that-path>` can
maintain the private file without placing credentials in Git or the plist.

## Claims, leases, and failures

Jobs are claimed transactionally with `FOR UPDATE SKIP LOCKED`. Dependencies must
already be Shipped, and the transaction admits a candidate only when its required
capabilities, global slot, project allowance, counted resources, and exclusive
repository/delivery keys are all available. The reservation is stored on the live
job lease, preventing either duplicate selection or a competing incompatible claim.
Project leases add defense in depth around repository/remote work. A lease records
its owner node, acquisition, heartbeat, and expiry. The worker checks both job and
project ownership immediately before shipping.

Expired execution/verification work becomes Blocked for inspection. An expired
reservation whose job is still Ready is also blocked because a restart cannot prove
that no runtime or preparation side effect began. If delivery intent was persisted,
recovery explicitly requires remote reconciliation and never replays the side effect. Optimistic revisions reject stale human updates. Outbox and
MCP delivery state are committed with domain state, so restart preserves delivery
intent and idempotency.

There is no offline multi-master mode. When PostgreSQL is unavailable, workers must
not use stale JSON or continue autonomous work. `/health` is deliberately local
process liveness and does not wake PostgreSQL; an explicit overview/status read
reports storage connectivity. Restoring database connectivity is required before
work continues.

## Daily control-plane health check

When PostgreSQL is the configured authority, the always-on Roundhouse service also
owns a lightweight control-plane check. At startup it reads the last successful
check timestamp and arms a one-shot timer for approximately 24 hours after that
success. If the timestamp is missing or overdue, it checks immediately. This is an
event-driven service timer: it does not create a Depot item, invoke a model, use a
ChatGPT automation, or run a frequent polling loop. A service or Mac restart
reconstructs the remaining delay from PostgreSQL.

The probe is `SELECT clock_timestamp()` through the repository's existing pool.
After that read succeeds, Roundhouse upserts only the resulting timestamp in
`roundhouse.control_plane_health`; credentials and connection details are never
copied into evidence or logs. Cached operational evidence is exposed at
`worker.control_plane_health` in `/health` and `/api/overview`, including
`last_success_at`, `next_check_at`, and any current error. `/health` itself remains
a local liveness read and does not issue a database query.

Failures use the service's existing `Worker:` stderr path and appear in the cached
health status. Retries begin after five minutes, double after each failure, and are
capped at six hours. A success clears the failure state and restores the daily
interval, so an outage cannot produce a tight database retry loop.

Installation follows the existing PostgreSQL upgrade procedure: back up the
database, stop the user service, install the verified application revision, and
restart it once. Startup applies migration 007 transactionally before the scheduler
starts. The macOS service wrapper continues to load `DATABASE_URL` only from the
private service environment; no new secret or plist setting is required. Do not
reconfigure a running Studio service unless the deployment policy for that service
explicitly authorizes it.

For rollback, stop the service and restore the prior application revision. The
additive `control_plane_health` table may safely remain for a prior version that
does not use it; avoid reversing an applied migration. Restart the prior revision
and verify `/health`. Removing the table is optional cleanup only after confirming
that no installed revision uses the scheduler.

## Backup, restore, and integration tests

Use provider snapshots plus standard logical backups. Example:

```sh
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" > roundhouse.dump
createdb roundhouse_restore_check
pg_restore --no-owner --no-acl --dbname roundhouse_restore_check roundhouse.dump
```

Test restores in a separate database before relying on them. To run the locking and
transaction suite, point `TEST_DATABASE_URL` at a disposable database whose name
contains `test`:

```sh
TEST_DATABASE_URL='postgresql://localhost/roundhouse_test' npm run test:postgres
```

The suite drops and recreates the `roundhouse` schema in that dedicated database.
Without `TEST_DATABASE_URL`, PostgreSQL tests report explicit skips while all
deterministic storage tests still run.
