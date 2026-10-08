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
    "mcp_deliveries", "nodes", "resource_leases", "import_provenance", "control_plane_health", "execution_outcomes"]) {
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

test("storage: daily health uses the configured pool and persists only its successful timestamp", async () => {
  const queries = [];
  const client = {
    query: async (sql, parameters = []) => {
      queries.push({ sql, parameters });
      if (/clock_timestamp/.test(sql)) return { rows: [{ checked_at: new Date("2026-06-01T00:00:00.000Z") }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const store = new PostgresStorageRepository({
    pool: { connect: async () => client },
    directory: os.tmpdir(),
    node: { id: "00000000-0000-4000-8000-000000000001", name: "health-node", capabilities: [] },
  });

  const evidence = await store.runControlPlaneHealthCheck();

  assert.deepEqual(evidence, { last_success_at: "2026-06-01T00:00:00.000Z" });
  assert.match(queries[0].sql, /^SELECT clock_timestamp/);
  assert.match(queries[1].sql, /control_plane_health/);
  assert.deepEqual(queries[1].parameters, [new Date("2026-06-01T00:00:00.000Z")]);
  assert.equal(queries.length, 2);
});
