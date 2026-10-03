import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { record } from "../src/workflow/state.js";
import { loadNodeIdentity } from "../src/storage/node-identity.js";
import { PostgresStorageRepository } from "../src/storage/postgres.js";
import { importLocalStateToPostgres } from "../src/storage/import-local-state.js";
import { Engine } from "../src/workflow/engine.js";
import { projectContext } from "../src/workflow/config.js";
import { composeAgentRole } from "../src/workflow/roles.js";
import { digest } from "../src/storage/repository.js";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = Boolean(connectionString);
const databaseName = enabled ? decodeURIComponent(new URL(connectionString).pathname.slice(1)) : "";
if (enabled && !/test/i.test(databaseName)) throw new Error("TEST_DATABASE_URL must name a dedicated database containing 'test'.");

async function reset() {
  const client = new pg.Client({ connectionString, ssl: ["localhost", "127.0.0.1", "::1"].includes(new URL(connectionString).hostname) ? undefined : { rejectUnauthorized: true } });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS roundhouse CASCADE");
  await client.end();
}

function node(directory, name) {
  return loadNodeIdentity(directory, { ROUNDHOUSE_NODE_NAME: name, ROUNDHOUSE_NODE_CAPABILITIES: "execution,shipping" });
}

async function open(name, leaseMs = 1000) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `roundhouse-pg-${name}-`));
  return PostgresStorageRepository.open({ connectionString, directory, node: node(directory, name), allowInsecure: true, leaseMs });
}

function seed(data, { deliveryIntent = false } = {}) {
  const item = record("item-1", { state: "Ready", input: { text: "ship", source: "test", actor: "test" }, clarifications: [], questions: [],
    decision: null, job_ids: ["job-1"], project_id: "project-1" });
  const job = record("job-1", { state: "Ready", parent_id: item.id, project_id: "project-1", work: { title: "work" }, agent_role: "general",
    project_context: {}, policy_hash: "hash", dependencies: [], attempts: [], processes: [], position: 1,
    ...(deliveryIntent ? { delivery_intent: { commit: "abc", branch: "codex/work", policy: "push_branch" } } : {}) });
  data.items[item.id] = item;
  data.jobs[job.id] = job;
  data.projects["project-1"] = { id: "project-1", active: false };
  data.outbox.push({ id: "event-1", entity_id: item.id, item_id: item.id, source: "test", state: "Ready", reason: "seed", at: new Date().toISOString(), delivered: false });
}

test("postgres: migrations, normalized restart projection, provenance, and outbox survive", { skip: !enabled }, async () => {
  await reset();
  const first = await open("first");
  await first.change((data) => {
    seed(data);
    data.items["item-1"].provenance = { source_system: "notion", source_id: "notion-1", imported_at: new Date().toISOString(), reconciled: false };
  });
  await first.compareAndChange("items", "item-1", 1, (_data, item) => {
    item.revision += 1;
    item.updated_at = new Date().toISOString();
  });
  await first.close();
  const restarted = await open("restart");
  const snapshot = await restarted.read();
  assert.equal(snapshot.jobs["job-1"].state, "Ready");
  assert.equal(snapshot.items["item-1"].provenance.source_id, "notion-1");
  assert.equal(snapshot.outbox[0].id, "event-1");
  const tables = await restarted.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='roundhouse'");
  assert.ok(tables.rows.length >= 25);
  assert.equal(Number((await restarted.pool.query("SELECT count(*) AS count FROM roundhouse.depot_item_revisions WHERE item_id='item-1'")).rows[0].count), 2);
  await restarted.close();
});

test("postgres: two nodes racing claim exactly one job and expose its owner", { skip: !enabled }, async () => {
  await reset();
  const first = await open("one");
  const second = await open("two");
  await first.change(seed);
  const claims = await Promise.all([first.claimJob(["project-1"]), second.claimJob(["project-1"])]);
  assert.equal(claims.filter(Boolean).length, 1);
  const winner = claims.find(Boolean);
  const snapshot = await first.read();
  assert.equal(snapshot.jobs["job-1"].owning_node_identity.id, winner.lease.owner_node_id);
  if (winner.lease.owner_node_id === first.node.id) await first.releaseLease(winner.lease);
  else await second.releaseLease(winner.lease);
  const projectLeases = await Promise.all([
    first.acquireLease("project", "project-1"), second.acquireLease("project", "project-1"),
  ]);
  assert.equal(projectLeases.filter(Boolean).length, 1);
  const projectWinner = projectLeases.find(Boolean);
  if (projectWinner.owner_node_id === first.node.id) await first.releaseLease(projectWinner);
  else await second.releaseLease(projectWinner);
  await first.close();
  await second.close();
});

test("postgres: racing workers execute and ship one claimed job exactly once", { skip: !enabled }, async () => {
  await reset();
  // Use the production lease window: a hosted database can spend more than
  // two seconds on the first transaction before the heartbeat is observable.
  const first = await open("worker-one", 60_000);
  const second = await open("worker-two", 60_000);
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-pg-project-"));
  const project = {
    id: "project-1", name: "Project", purpose: "Test claims", success_state: "One delivery", status: "active", repository,
    context_sources: [], context_limits: { max_files: 10, max_file_bytes: 10_000, max_total_bytes: 20_000 },
    agent: { default_role: "general", allowed_roles: ["general"], context_sources: {}, skill_sources: {} },
    executor: { kind: "command", command: ["true"] }, runtime: "local", remote: "origin", timeout_ms: 10_000, weight: 1,
    policy: { allow_autonomous: true, approval_required: false, shipping: "commit_only", continuation: "continue_project_queue",
      max_rework_attempts: 0, review_after_shipping: false }, verification: [],
  };
  const contextual = { ...projectContext(project, { role: "general" }), agent_profile: composeAgentRole("general", project) };
  await first.change((data) => {
    seed(data);
    data.jobs["job-1"].project_context = contextual;
    data.jobs["job-1"].policy_hash = digest(contextual);
  });
  let executions = 0;
  const runtime = { execute: async () => { executions += 1; await new Promise((resolve) => setTimeout(resolve, 30));
    return { passed: true, exit_code: 0, command: ["fixture"], started_at: new Date().toISOString(), finished_at: new Date().toISOString() }; } };
  const verifier = { verify: async ({ commit }) => ({ commit, at: new Date().toISOString(), passed: true, checks: [] }) };
  const shipping = {
    lock: () => { const release = () => {}; release.directory = null; return release; },
    supports: () => true,
    prepare: () => ({ workspace: repository, branch: "codex/test" }),
    snapshot: () => ({ commit: "commit-one" }),
    unchanged: () => true,
    ship: async ({ verification }) => ({ commit: verification.commit, branch: "codex/test", pushed: false,
      timestamp: new Date().toISOString(), verification }),
  };
  const config = { projects: [project], max_jobs_per_run: 1 };
  const results = await Promise.all([
    new Engine({ store: first, config, runtime, verifier, shipping }).run(),
    new Engine({ store: second, config, runtime, verifier, shipping }).run(),
  ]);
  assert.equal(executions, 1);
  assert.equal(results.reduce((sum, result) => sum + result.executed, 0), 1);
  assert.equal((await first.read()).jobs["job-1"].state, "Shipped");
  await first.close();
  await second.close();
});

test("postgres: expired leases recover without duplicate delivery and stale revisions fail", { skip: !enabled }, async () => {
  await reset();
  const first = await open("short", 30);
  const second = await open("recovery", 30);
  await first.change((data) => seed(data, { deliveryIntent: true }));
  const claim = await first.claimJob(["project-1"], 30);
  await first.change((data) => { data.jobs["job-1"].state = "Executing"; data.jobs["job-1"].revision += 1; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await second.recoverExpiredClaims(), 1);
  const recovered = await second.read();
  assert.equal(recovered.jobs["job-1"].state, "Blocked");
  assert.match(recovered.jobs["job-1"].history.at(-1).reason, /delivery intent.*reconcile/i);
  assert.equal(await second.claimJob(["project-1"]), null);
  await assert.rejects(second.compareAndChange("items", "item-1", 999, () => {}), /Stale revision/);
  await first.releaseLease(claim.lease);
  await first.close();
  await second.close();
});

test("postgres: native state import preserves IDs/history and never starts pending work", { skip: !enabled }, async () => {
  await reset();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-pg-import-"));
  const local = { schema_version: 1, items: {}, jobs: {}, projects: {}, project_candidates: {}, system_metadata: {}, outbox: [] };
  seed(local);
  local.items["item-1"].state = "Imported Pending";
  local.items["item-1"].requires_reevaluation = true;
  local.items["item-1"].execution_eligible = false;
  local.items["item-1"].provenance = { source_system: "notion", source_id: "notion-19", imported_at: new Date().toISOString(), reconciled: false };
  local.jobs["job-1"].state = "Shipped";
  const localBytes = JSON.stringify(local);
  fs.writeFileSync(path.join(directory, "state.json"), localBytes);
  const report = await importLocalStateToPostgres({ stateDirectory: directory, connectionString, allowInsecure: true,
    env: { ROUNDHOUSE_NODE_NAME: "importer" } });
  assert.equal(report.imported_pending_count, 1);
  assert.equal(report.shipped_job_count, 1);
  assert.equal(report.notion_record_count, 1);
  assert.equal(report.execution_started, false);
  assert.ok(fs.existsSync(report.backup));
  assert.equal(fs.readFileSync(path.join(directory, "state.json"), "utf8"), localBytes);
  const imported = await open("verify");
  const snapshot = await imported.read();
  assert.equal(snapshot.items["item-1"].state, "Imported Pending");
  assert.equal(snapshot.jobs["job-1"].state, "Shipped");
  assert.equal(snapshot.items["item-1"].provenance.source_id, "notion-19");
  await imported.close();
});
