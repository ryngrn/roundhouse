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

test("storage: no DATABASE_URL selects the explicit single-node local repository", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-local-storage-"));
  const store = await openStorage({ directory, env: {} });
  assert.equal(store.kind, "local");
  assert.equal(store.shared, false);
  assert.match(store.status().warning, /single-node/);
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
