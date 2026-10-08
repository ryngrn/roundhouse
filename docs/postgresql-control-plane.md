# PostgreSQL authoritative control plane

This describes the optional generic PostgreSQL storage adapter and its tests. It is
not enabled on the Mac Studio: the Studio's local `state.json` store is authoritative,
and the Aiven database is used only for dashboard projection and remote commands.
Roundhouse does not depend on Neon. Reintroducing shared authoritative storage
requires an explicit provider decision and a separately verified cutover.

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

The macOS service wrapper forces local authoritative storage and ignores legacy
database environment variables. The separate `relay.env` contains the Aiven relay
connection and wake configuration; it must remain a regular mode-0400 or mode-0600
file owned by the service user.

## Claims, leases, and failures

Jobs are claimed transactionally with `FOR UPDATE SKIP LOCKED`. Dependencies must
already be Shipped, and a live job lease prevents another node from claiming the
same work. Project leases serialize repository/remote resources across nodes. A
lease records its owner node, acquisition, heartbeat, and expiry. The worker checks
both job and project ownership immediately before shipping.

Expired execution/verification work becomes Blocked for inspection. If delivery
intent was persisted, recovery explicitly requires remote reconciliation and never
replays the side effect. Optimistic revisions reject stale human updates. Outbox and
MCP delivery state are committed with domain state, so restart preserves delivery
intent and idempotency.

There is no offline multi-master mode. When PostgreSQL is unavailable, workers must
not use stale JSON or continue autonomous work. `/health` is deliberately local
process liveness and does not wake PostgreSQL; an explicit overview/status read
reports storage connectivity. Restoring database connectivity is required before
work continues.

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
