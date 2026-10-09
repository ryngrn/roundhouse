import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadNodeIdentity } from "../src/storage/node-identity.js";
import { openStorage } from "../src/storage/open.js";
import { importLocalStateToPostgres } from "../src/storage/import-local-state.js";
import { PostgresStorageRepository } from "../src/storage/postgres.js";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("storage: node identity is stable while name and capabilities remain operator-configurable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-node-"));
  const first = loadNodeIdentity(directory, { ROUNDHOUSE_NODE_NAME: "studio-a", ROUNDHOUSE_NODE_CAPABILITIES: "execution,verification" });
  const second = loadNodeIdentity(directory, { ROUNDHOUSE_NODE_NAME: "renamed", ROUNDHOUSE_NODE_CAPABILITIES: "decision" });
  assert.equal(first.id, second.id);
  assert.equal(second.name, "renamed");
  assert.deepEqual(second.capabilities, ["decision"]);
  assert.equal(fs.statSync(path.join(directory, "node-identity.json")).mode & 0o777, 0o600);
});

test("storage: local is the default authority even when DATABASE_URL exists", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-local-storage-"));
  const store = await openStorage({ directory, env: { DATABASE_URL: "postgresql://should-not-be-used.invalid/db" } });
  assert.equal(store.kind, "local");
  assert.equal(store.shared, false);
  assert.match(store.status().warning, /single-node/);
});

test("storage: PostgreSQL authority requires an explicit storage mode", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-postgres-mode-"));
  await assert.rejects(openStorage({ directory, env: { ROUNDHOUSE_STORAGE_MODE: "postgresql" } }), /requires DATABASE_URL/);
  await assert.rejects(openStorage({ directory, env: { ROUNDHOUSE_STORAGE_MODE: "wat" } }), /Unsupported ROUNDHOUSE_STORAGE_MODE/);
});

test("storage: PostgreSQL import refuses to invent credentials or alter the local snapshot", async () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-import-no-db-"));
  const directory = path.join(rootDirectory, "state");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({ schema_version: 1, items: {}, jobs: {}, projects: {}, project_candidates: {}, system_metadata: {}, outbox: [] }));
  const before = fs.readFileSync(path.join(directory, "state.json"), "utf8");
  await assert.rejects(importLocalStateToPostgres({ stateDirectory: directory, connectionString: "" }), /DATABASE_URL/);
  assert.equal(fs.readFileSync(path.join(directory, "state.json"), "utf8"), before);
  assert.equal(fs.existsSync(path.join(rootDirectory, "migrations")), false);
});

test("storage: forward migrations normalize control-plane domains and contain no state blob", () => {
  const sql = fs.readdirSync(path.join(root, "src/storage/migrations")).sort()
    .map((name) => fs.readFileSync(path.join(root, "src/storage/migrations", name), "utf8")).join("\n");
  for (const table of ["system_metadata", "projects", "project_candidates", "depot_items", "depot_item_revisions", "decisions", "questions",
    "answers", "jobs", "job_dependencies", "job_attempts", "agent_role_refs", "execution_metadata", "verification_results",
    "verification_checks", "shipping_records", "deployments", "transition_audit", "outbox_events", "mcp_subscriptions",
    "mcp_deliveries", "nodes", "resource_leases", "import_provenance"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS roundhouse\\.${table}\\b`));
  }
  assert.doesNotMatch(sql, /state_blob|snapshot_blob|CREATE TABLE[^;]*state_json/is);
  assert.match(sql, /expires_at timestamptz NOT NULL/);
});

test("storage: a disconnected PostgreSQL authority reports read-only health instead of local fallback", async () => {
  const store = new PostgresStorageRepository({
    pool: { query: async () => { throw new Error("network unavailable"); } },
    directory: os.tmpdir(),
    node: { id: "00000000-0000-4000-8000-000000000001", name: "offline-node", capabilities: ["execution"] },
  });
  const status = await store.status();
  assert.equal(status.connected, false);
  assert.equal(status.read_only, true);
  assert.equal(status.authoritative, true);
  assert.equal(status.node.name, "offline-node");
});

function postgresPoolFixture({ projects = [], fail = () => false } = {}) {
  const queries = [];
  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (fail(sql, parameters)) throw new Error("injected write failure");
      if (/SELECT key, value FROM roundhouse\.system_metadata/.test(sql)) return { rows: [] };
      if (/SELECT id, payload FROM roundhouse\.projects/.test(sql)) return { rows: projects.map((payload) => ({ id: payload.id, payload })) };
      if (/SELECT id, payload FROM roundhouse\.project_candidates/.test(sql)) return { rows: [] };
      if (/SELECT id, payload FROM roundhouse\.depot_items/.test(sql)) return { rows: [] };
      if (/FROM roundhouse\.jobs j LEFT JOIN/.test(sql)) return { rows: [] };
      if (/SELECT payload FROM roundhouse\.outbox_events/.test(sql)) return { rows: [] };
      if (/SELECT id, payload FROM roundhouse\.mcp_subscriptions/.test(sql)) return { rows: [] };
      if (/SELECT id, payload FROM roundhouse\.mcp_deliveries/.test(sql)) return { rows: [] };
      if (/SELECT key, value FROM roundhouse\.mcp_event_state/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { queries, pool: { connect: async () => client } };
}

function postgresFixtureStore(pool) {
  return new PostgresStorageRepository({
    pool,
    directory: os.tmpdir(),
    node: { id: "00000000-0000-4000-8000-000000000001", name: "fixture", capabilities: [] },
  });
}

test("storage: PostgreSQL change persists only changed domain records", async () => {
  const first = { id: "first", name: "First", revision: 1 };
  const second = { id: "second", name: "Second", revision: 1 };
  const fixture = postgresPoolFixture({ projects: [first, second] });
  const store = postgresFixtureStore(fixture.pool);

  await store.change((data) => { data.projects.first.name = "Changed"; });

  const writes = fixture.queries.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /INSERT INTO roundhouse\.projects/);
  assert.equal(writes[0].parameters[0], "first");
  assert.doesNotMatch(writes.map(({ sql }) => sql).join("\n"), /TRUNCATE|depot_items|roundhouse\.jobs\b/i);
  assert.equal(fixture.queries.at(-1).sql, "COMMIT");
});

test("storage: PostgreSQL change rolls back all incremental writes after a database failure", async () => {
  const fixture = postgresPoolFixture({
    projects: [{ id: "first", name: "First", revision: 1 }, { id: "second", name: "Second", revision: 1 }],
    fail: (sql, parameters) => /INSERT INTO roundhouse\.projects/.test(sql) && parameters[0] === "second",
  });
  const store = postgresFixtureStore(fixture.pool);

  await assert.rejects(store.change((data) => {
    data.projects.first.name = "Changed first";
    data.projects.second.name = "Changed second";
  }), /injected write failure/);

  assert.equal(fixture.queries.filter(({ sql }) => /INSERT INTO roundhouse\.projects/.test(sql)).length, 2);
  assert.equal(fixture.queries.at(-1).sql, "ROLLBACK");
  assert.equal(fixture.queries.some(({ sql }) => sql === "COMMIT"), false);
});

test("storage: PostgreSQL change can populate an empty authority for initial import", async () => {
  const fixture = postgresPoolFixture();
  const store = postgresFixtureStore(fixture.pool);

  await store.change((data) => {
    data.system_metadata.postgres_import = { source_digest: "digest" };
    data.projects.studio = { id: "studio", name: "Studio", revision: 1 };
  });

  const sql = fixture.queries.map((query) => query.sql).join("\n");
  assert.match(sql, /INSERT INTO roundhouse\.system_metadata/);
  assert.match(sql, /INSERT INTO roundhouse\.projects/);
  assert.doesNotMatch(sql, /TRUNCATE/);
  assert.equal(fixture.queries.at(-1).sql, "COMMIT");
});
