import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresStorageRepository } from "../src/storage/postgres.js";

const migration = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../src/storage/migrations/007_durable_decision_attempts.sql");
const nodeId = "00000000-0000-4000-8000-000000000001";
const lease = { resource_kind: "item", resource_key: "item-1", token: "short-owner" };

function fixture({ leaseOwned = true, receiptValid = true, itemRevision = 3 } = {}) {
  const queries = [];
  const client = {
    async query(sql, args = []) {
      queries.push({ sql, args });
      if (sql.includes("SELECT 1 FROM roundhouse.resource_leases"))
        return { rows: leaseOwned ? [{ ok: 1 }] : [], rowCount: leaseOwned ? 1 : 0 };
      if (sql.includes("SELECT revision,state,payload FROM roundhouse.depot_items"))
        return { rows: [{ revision: itemRevision, state: "Decision", payload: { awaiting_decision: false } }], rowCount: 1 };
      if (sql.includes("INSERT INTO roundhouse.decision_attempts"))
        return { rows: [{ started_at: new Date(), deadline_at: new Date(Date.now() + 600_000) }], rowCount: 1 };
      if (sql.includes("SELECT 1 FROM roundhouse.decision_attempts"))
        return { rows: receiptValid ? [{ ok: 1 }] : [], rowCount: receiptValid ? 1 : 0 };
      if (sql.includes("FROM roundhouse.system_metadata")) return { rows: [] };
      if (sql.includes("FROM roundhouse.projects")) return { rows: [] };
      if (sql.includes("FROM roundhouse.project_candidates")) return { rows: [] };
      if (sql.includes("FROM roundhouse.depot_items ORDER BY")) return { rows: [] };
      if (sql.includes("FROM roundhouse.jobs j LEFT JOIN")) return { rows: [] };
      if (sql.includes("FROM roundhouse.outbox_events")) return { rows: [] };
      if (sql.includes("FROM roundhouse.mcp_subscriptions")) return { rows: [] };
      if (sql.includes("FROM roundhouse.mcp_deliveries")) return { rows: [] };
      if (sql.includes("FROM roundhouse.mcp_event_state")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const store = new PostgresStorageRepository({
    pool: { connect: async () => client }, directory: os.tmpdir(),
    node: { id: nodeId, name: "fixture", capabilities: ["decision"] },
  });
  return { store, queries };
}

test("durable decision migration is additive and fences single active attempt per item", () => {
  const sql = fs.readFileSync(migration, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS roundhouse\.decision_attempts/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS decision_attempts_one_running_idx/);
  assert.match(sql, /WHERE status='running'/);
  assert.match(sql, /start_revision bigint NOT NULL/);
  assert.match(sql, /deadline_at timestamptz NOT NULL/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/);
  assert.doesNotMatch(sql, /TRUNCATE|DROP TABLE|pg_cron|CREATE EXTENSION/);
});

test("durable decision receipt requires the active short item claim", async () => {
  const { store, queries } = fixture();
  const receipt = await store.startDecisionAttempt("item-1", lease);
  assert.equal(receipt.item_id, "item-1");
  assert.equal(receipt.start_revision, 3);
  assert.equal(queries.at(-1).sql, "COMMIT");
  const lockIndex = queries.findIndex(({ sql }) => sql.includes("SELECT 1 FROM roundhouse.resource_leases"));
  const receiptIndex = queries.findIndex(({ sql }) => sql.includes("INSERT INTO roundhouse.decision_attempts"));
  assert.ok(lockIndex > 0 && receiptIndex > lockIndex);
  assert.deepEqual(queries[lockIndex].args, ["item-1", nodeId, lease.token]);

  const denied = fixture({ leaseOwned: false });
  await assert.rejects(denied.store.startDecisionAttempt("item-1", lease), /Lease lost/);
  assert.equal(denied.queries.at(-1).sql, "ROLLBACK");
  assert.equal(denied.queries.some(({ sql }) => sql.includes("INSERT INTO roundhouse.decision_attempts")), false);
});

test("receipt validation precedes state reads and finalization is atomic", async () => {
  const { store, queries } = fixture();
  const receipt = { id: "receipt-1", item_id: "item-1", token: "opaque", start_revision: 3 };
  await store.change((data) => { data.system_metadata.decision_marker = "safe"; },
    { decisionAttempt: receipt, decisionOutcome: "completed" });
  const validated = queries.findIndex(({ sql }) => sql.includes("SELECT 1 FROM roundhouse.decision_attempts"));
  const read = queries.findIndex(({ sql }) => sql.includes("FROM roundhouse.system_metadata"));
  const finalized = queries.findIndex(({ sql }) => sql.includes("UPDATE roundhouse.decision_attempts"));
  assert.ok(validated > 0 && read > validated && finalized > read);
  assert.equal(queries.at(-1).sql, "COMMIT");
  assert.deepEqual(queries[validated].args, ["receipt-1", "item-1", "opaque", 3]);

  const stale = fixture({ receiptValid: false });
  let mutated = false;
  await assert.rejects(stale.store.change(() => { mutated = true; },
    { decisionAttempt: receipt, decisionOutcome: "completed" }), /stale or expired/);
  assert.equal(mutated, false);
  assert.equal(stale.queries.at(-1).sql, "ROLLBACK");
  assert.equal(stale.queries.some(({ sql }) => sql.includes("UPDATE roundhouse.decision_attempts")), false);
});
