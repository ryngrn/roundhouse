import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Engine } from "../src/workflow/engine.js";
import { loadWorkflowConfig } from "../src/workflow/config.js";
import { Store } from "../src/workflow/store.js";
import { WorkerLoop } from "../src/server/worker.js";
import { selectTriageCandidates } from "../src/workflow/triage.js";
import { itemView } from "../src/workflow/views.js";
import { harness } from "./support/harness.js";

function executable(project, changes = {}) {
  return {
    project: project.id, project_confidence: 0.99, execution_confidence: 0.99,
    sufficient_context: true, safe_to_execute: true, approval_required: false,
    decision: "execute", reason: "Clear, bounded and reversible.", questions: [], dependencies: [],
    executor: project.executor.kind, runtime: project.runtime, shipping_policy: project.policy.shipping,
    should_decompose: false,
    work_items: [{ title: "Focused slice", outcome: "Deliver the requested bounded outcome.", acceptance_criteria: [] }],
    ...changes,
  };
}

function engineWith(h, decide, options = {}) {
  return new Engine({ store: h.store, config: h.config, decision: { decide }, ...options });
}

test("shared worker serializes triage and dispatch into one control-plane cycle", async () => {
  let active = 0;
  let peak = 0;
  let triageCalls = 0;
  let dispatchCalls = 0;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
  const engine = {
    store: { shared: true },
    runTriage: async () => {
      triageCalls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await pause();
      active -= 1;
      return { triaged: 0 };
    },
    runDispatch: async () => {
      dispatchCalls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await pause();
      active -= 1;
      return { executed: 0 };
    },
  };
  const worker = new WorkerLoop({ service: { engine } });
  await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(peak, 1);
  assert.equal(triageCalls, 1);
  assert.equal(dispatchCalls, 1);
});

test("shared worker routes one queued remote signal before triage and dispatch", async () => {
  const order = [];
  let queued = { id: "command-1", kind: "intake", payload: { content: "phone intake" } };
  let finished;
  const store = {
    shared: true,
    claimRemoteCommand: async () => { const command = queued; queued = null; return command; },
    finishRemoteCommand: async (id, outcome) => { finished = { id, ...outcome }; },
  };
  const service = {
    store,
    addToDepot: async (payload, adapter) => {
      order.push("command");
      assert.equal(payload.content, "phone intake");
      assert.equal(adapter.source, "remote-dashboard");
      return { item: { id: "item-1" } };
    },
    engine: {
      store,
      runTriage: async () => { order.push("triage"); return { triaged: 0 }; },
      runDispatch: async () => { order.push("dispatch"); return { executed: 0 }; },
    },
  };
  const worker = new WorkerLoop({ service, commandQueue: store });
  const result = await worker.tick();
  assert.deepEqual(order, ["command", "triage", "dispatch"]);
  assert.equal(result.remote_commands, 1);
  assert.equal(finished.id, "command-1");
  assert.equal(finished.result.item.id, "item-1");
});

test("continuous triage automatically evaluates new Depot work without dispatch", async () => {
  const h = harness();
  const item = h.submit("automatic control-plane evaluation");
  let calls = 0;
  const engine = engineWith(h, async ({ projects }) => { calls += 1; return executable(projects[0]); });
  const worker = new WorkerLoop({ service: { engine } });
  const result = await worker.triageTick();
  const state = h.store.read();
  assert.equal(result.triaged, 1);
  assert.equal(calls, 1);
  assert.equal(state.items[item.id].state, "Ready");
  assert.equal(state.jobs[`${item.id}-1`].state, "Ready");
  assert.equal(state.jobs[`${item.id}-1`].attempts.length, 0);
});

test("readiness retains work while reporting unavailable slice capabilities", async () => {
  const h = harness();
  const item = h.submit("research, schedule, and publish the result");
  const engine = engineWith(h, async ({ projects }) => executable(projects[0], {
    work_items: [{ title: "Prepare research", outcome: "A sourced artifact is prepared for later coordination.",
      repository_required: true, required_capabilities: ["research", "scheduling", "artifact"], acceptance_criteria: [] }],
  }));
  await engine.runTriage();
  const ready = itemView(h.store.read(), h.store.read().items[item.id]);
  assert.equal(ready.state, "Ready");
  assert.equal(ready.execution_eligible, false);
  assert.equal(ready.execution_ineligibility_reasons[0].code, "capability_mismatch");
  assert.match(ready.execution_ineligibility_reasons[0].message, /research, scheduling, artifact/);
  const dispatched = await engine.runDispatch();
  assert.equal(dispatched.executed, 0);
  assert.equal(itemView(dispatched, dispatched.items[item.id]).jobs[0].allocation.reason.code, "capability_mismatch");
});

test("Imported Pending is explicitly released, audited and triaged but never executed by triage", async () => {
  const h = harness();
  const item = h.submit("legacy Ready evidence");
  h.store.change((data) => Object.assign(data.items[item.id], {
    state: "Imported Pending", requires_reevaluation: true, execution_eligible: false,
    provenance: { source_system: "notion", source_id: "source-1" },
    legacy_depot: { Status: "Ready", "Workflow State": "Running" },
  }));
  let executions = 0;
  const engine = engineWith(h, async ({ projects }) => executable(projects[0]), {
    runtime: { execute: async () => { executions += 1; throw new Error("triage must not execute"); } },
  });
  await engine.runTriage({ limit: 1 });
  const current = h.store.read().items[item.id];
  assert.equal(current.state, "Ready");
  assert.equal(executions, 0);
  assert.equal(current.imported_release.legacy_status, "Ready");
  assert.match(current.imported_release.reason, /no execution authority/);
  assert.ok(current.history.some((event) => event.from === "Imported Pending" && event.to === "Depot"));
  assert.ok(current.history.some((event) => event.from === "Depot" && event.to === "Decision"));
});

test("dispatch waits until the imported migration wave has completed triage", async () => {
  const h = harness();
  const ready = h.submit("already ready", "ready");
  const imported = h.submit("still needs safe imported triage", "imported");
  h.store.change((data) => {
    data.items[ready.id].state = "Ready";
    data.items[ready.id].job_ids = [`${ready.id}-1`];
    data.jobs[`${ready.id}-1`] = { id: `${ready.id}-1`, parent_id: ready.id, project_id: "example", state: "Ready", revision: 1,
      work: { title: "ready" }, dependencies: [], attempts: [], history: [], created_at: new Date().toISOString(), priority_rank: 0, position: 0 };
    Object.assign(data.items[imported.id], { state: "Imported Pending", requires_reevaluation: true,
      provenance: { source_system: "notion", source_id: "source-2" }, legacy_depot: { Status: "Ready" } });
  });
  let executions = 0;
  const engine = engineWith(h, async ({ projects }) => executable(projects[0]), {
    runtime: { execute: async () => { executions += 1; return { passed: true }; } },
  });
  const result = await engine.runDispatch();
  assert.equal(result.executed, 0);
  assert.equal(result.triage_barrier, true);
  assert.equal(executions, 0);
  assert.equal(h.store.read().jobs[`${ready.id}-1`].state, "Ready");
});

test("triage prioritizes P0 and preserves weighted fairness across retry candidates", async () => {
  const h = harness();
  const p2 = h.submit("P2", "p2");
  const p0 = h.submit("P0", "p0");
  h.store.change((data) => { data.items[p2.id].priority_rank = 2; data.items[p0.id].priority_rank = 0; });
  const order = [];
  const engine = engineWith(h, async ({ item, projects }) => { order.push(item.id); return executable(projects[0]); });
  await engine.runTriage({ limit: 1 });
  assert.deepEqual(order, [p0.id]);

  const snapshot = h.store.read();
  snapshot.items[p0.id].state = "Depot";
  snapshot.items[p0.id].job_ids = [];
  snapshot.items[p0.id].triage.last_selected_sequence = 8;
  snapshot.items[p2.id].triage = { last_selected_sequence: 0 };
  assert.equal(selectTriageCandidates(snapshot, h.config, h.store, { limit: 1 })[0].item.id, p2.id);
});

test("broad work is sliced with dependencies and routine criteria are inferred", async () => {
  const h = harness();
  const item = h.submit("broad but clear");
  const engine = engineWith(h, async ({ projects }) => executable(projects[0], {
    should_decompose: true,
    work_items: [
      { title: "First slice", outcome: "First useful outcome", acceptance_criteria: [] },
      { title: "Second slice", outcome: "Second useful outcome", acceptance_criteria: [] },
    ],
  }));
  await engine.runTriage({ limit: 1 });
  const state = h.store.read();
  assert.equal(state.items[item.id].job_ids.length, 2);
  assert.deepEqual(state.jobs[`${item.id}-2`].dependencies, [`${item.id}-1`]);
  assert.ok(state.items[item.id].decision.work_items.every((work) => work.acceptance_criteria.length >= 2));
  assert.ok(state.items[item.id].decision.work_items.every((work) => work.acceptance_criteria.some((criterion) => criterion.verification_ids.includes("feature"))));
});

test("material ambiguity becomes focused Needs You and is not re-polled until revision changes", async () => {
  const h = harness();
  const item = h.submit("material choice");
  let calls = 0;
  const engine = engineWith(h, async ({ projects }) => {
    calls += 1;
    return executable(projects[0], {
      decision: "clarify", sufficient_context: false, project_confidence: 0.99, execution_confidence: 0.4,
      reason: "One product decision changes the outcome.",
      questions: [{ prompt: "Which audience should this serve?", decision_key: "audience" }], work_items: [],
    });
  });
  await engine.runTriage({ limit: 1 });
  await engine.runTriage({ limit: 1 });
  const current = h.store.read().items[item.id];
  assert.equal(calls, 1);
  assert.equal(current.state, "Needs Clarification");
  assert.equal(current.questions.filter((question) => question.status === "open").length, 1);
  assert.equal(itemView(h.store.read(), current).display_state, "Needs a signal");
});

test("project naming remains a focused Needs You decision before configuration blocking", async () => {
  const h = harness();
  const item = h.store.submit({ text: "Create a new product after its durable name is chosen.", project_hint: "Unnamed product",
    source: "test", actor: "test" }, "unnamed-project");
  const engine = engineWith(h, async () => ({
    project: null, project_confidence: 0.99, execution_confidence: 0,
    sufficient_context: false, safe_to_execute: false, approval_required: false,
    decision: "clarify", reason: "Naming changes the durable project identity.",
    questions: [{ prompt: "What durable name should this project use?", decision_key: "project.durable_name" }],
    dependencies: [], executor: "codex", runtime: "local", shipping_policy: "push_branch",
    should_decompose: false, work_items: [],
  }));
  await engine.runTriage({ limit: 1 });
  const current = h.store.read().items[item.id];
  assert.equal(current.state, "Needs Clarification");
  assert.equal(current.questions.filter((question) => question.status === "open").length, 1);
  assert.equal(current.questions.find((question) => question.status === "open").prompt, "What durable name should this project use?");
});

test("blocked dependencies are fingerprint-gated and retry only after relevant revision change", async () => {
  const h = harness();
  h.submit("needs shared dependency");
  let calls = 0;
  const engine = engineWith(h, async ({ projects }) => {
    calls += 1;
    return executable(projects[0], { decision: "block", reason: "Shared database is not ready.", blocked_on: ["shared-postgres"], work_items: [] });
  });
  await engine.runTriage({ limit: 1 });
  await engine.runTriage({ limit: 1 });
  assert.equal(calls, 1);
  h.store.change((data) => { data.system_metadata.triage_dependency_revisions = { shared_postgres: 2 }; });
  await engine.runTriage({ limit: 1 });
  assert.equal(calls, 2);
});

test("reconciliation requires an exact durable identity and terminal history is untouched", async () => {
  const h = harness();
  const target = h.submit("native shipped equivalent", "native");
  const duplicate = h.store.submit({ text: "legacy copy", project_id: "example", source: "test", actor: "test", metadata: { duplicate_of: target.id } }, "duplicate");
  const fuzzy = h.store.submit({ text: "sounds similar", project_id: "example", source: "test", actor: "test" }, "fuzzy");
  h.store.change((data) => {
    data.items[target.id].state = "Imported History";
    data.items[duplicate.id].priority_rank = 0;
    data.items[fuzzy.id].priority_rank = 1;
  });
  const engine = engineWith(h, async ({ item, projects }) => executable(projects[0], {
    decision: "reconcile", reason: "Proposed native equivalent.", reconcile_with: target.id, work_items: [],
  }));
  await engine.runTriage({ limit: 2 });
  const state = h.store.read();
  assert.equal(state.items[target.id].state, "Imported History");
  assert.equal(state.items[target.id].triage, undefined);
  assert.equal(state.items[duplicate.id].state, "Reconciled");
  assert.equal(state.items[duplicate.id].reconciled_with, target.id);
  assert.equal(state.items[fuzzy.id].state, "Blocked");
});

test("two shared triage workers race to one evaluation", async () => {
  const h = harness();
  h.submit("race once");
  const leases = new Map();
  const store = h.store;
  store.shared = true;
  store.leaseMs = 10_000;
  store.acquireLease = async (kind, key) => {
    const id = `${kind}:${key}`;
    if (leases.has(id)) return null;
    const lease = { resource_kind: kind, resource_key: key, token: randomUUID() };
    leases.set(id, lease.token);
    return lease;
  };
  store.releaseLease = async (lease) => { if (leases.get(`${lease.resource_kind}:${lease.resource_key}`) === lease.token) leases.delete(`${lease.resource_kind}:${lease.resource_key}`); };
  store.heartbeatLease = async () => {};
  store.assertLease = async () => {};
  store.heartbeatNode = async () => {};
  store.recoverExpiredClaims = async () => 0;
  let calls = 0;
  const decide = async ({ projects }) => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 40)); return executable(projects[0]); };
  const first = engineWith(h, decide);
  const second = engineWith(h, decide);
  await Promise.all([first.runTriage({ limit: 1 }), second.runTriage({ limit: 1 })]);
  assert.equal(calls, 1);
  assert.equal(Object.keys(h.store.read().jobs).length, 1);
});

test("triage failures persist exponential backoff and do not spin", async () => {
  const h = harness();
  const item = h.submit("provider failure");
  h.config.triage.base_backoff_ms = 100;
  h.config.triage.max_backoff_ms = 1_000;
  let now = 1_000;
  let calls = 0;
  const engine = engineWith(h, async () => { calls += 1; throw new Error("temporary outage"); }, { clock: () => now });
  await engine.runTriage({ limit: 1 });
  await engine.runTriage({ limit: 1 });
  assert.equal(calls, 1);
  let current = h.store.read().items[item.id];
  assert.equal(current.state, "Depot");
  assert.equal(current.triage.failure_count, 1);
  assert.equal(current.triage.last_error, "temporary outage");
  now = 1_101;
  await engine.runTriage({ limit: 1 });
  current = h.store.read().items[item.id];
  assert.equal(calls, 2);
  assert.equal(current.triage.failure_count, 2);
  assert.equal(Date.parse(current.triage.next_attempt_at), 1_301);
});

test("triage continues while execution capacity is full and policy still gates jobs", async () => {
  const h = harness({ policy: { allow_autonomous: false } });
  const active = h.submit("already running", "active");
  const waiting = h.submit("new control-plane work", "waiting");
  h.store.change((data) => {
    data.items[active.id].state = "Ready";
    data.items[active.id].job_ids = [`${active.id}-1`];
    data.jobs[`${active.id}-1`] = { id: `${active.id}-1`, parent_id: active.id, project_id: "example", state: "Executing", revision: 1,
      work: { title: "active" }, dependencies: [], attempts: [], history: [], created_at: new Date().toISOString() };
  });
  const engine = engineWith(h, async ({ projects }) => executable(projects[0]));
  await engine.runTriage({ limit: 1 });
  const state = h.store.read();
  assert.equal(state.items[waiting.id].state, "Review");
  assert.equal(state.items[waiting.id].job_ids.length, 0);
  assert.equal(state.jobs[`${active.id}-1`].state, "Executing");
});

test("Roundhouse self-project is isolated, single-concurrency and cannot merge or restart itself", () => {
  const config = loadWorkflowConfig(path.resolve("config/roundhouse.autonomy.yaml"));
  const project = config.projects.find((candidate) => candidate.id === "roundhouse");
  assert.equal(project.max_concurrent_runs, 1);
  assert.equal(project.policy.shipping, "push_branch");
  assert.equal(project.self_hosting.isolated_worktree, true);
  assert.equal(project.self_hosting.restart_after_delivery, false);
  assert.deepEqual(project.verification.map((rule) => rule.id), ["tests", "acceptance", "syntax", "whitespace"]);
});

test("a dirty self-hosting repository remains Ready instead of being claimed", async () => {
  const h = harness();
  const item = h.submit("safe self change");
  const project = h.config.projects[0];
  project.self_hosting = { isolated_worktree: true, restart_after_delivery: false };
  fs.writeFileSync(path.join(h.repository, "external-work.txt"), "active external work");
  const engine = engineWith(h, async ({ projects }) => executable(projects[0]));
  const result = await engine.run();
  assert.equal(result.executed, 0);
  assert.equal(result.jobs[`${item.id}-1`].state, "Ready");
  assert.equal(result.projects.example?.blocked, undefined);
});

test("unavailable shared authority stops triage and dispatch before stale work can run", async () => {
  let runtimeCalls = 0;
  const unavailable = {
    kind: "postgresql", shared: true, leaseMs: 1000, node: { id: "node", name: "node" },
    heartbeatNode: async () => { throw new Error("PostgreSQL unavailable"); },
    recoverExpiredClaims: async () => 0,
    read: async () => { throw new Error("PostgreSQL unavailable"); },
  };
  const config = { projects: [], decision: { kind: "command", command: ["false"] }, max_jobs_per_run: 1,
    triage: { max_per_tick: 1, max_concurrent: 1, base_backoff_ms: 10, max_backoff_ms: 100 } };
  const engine = new Engine({ store: unavailable, config, runtime: { execute: async () => { runtimeCalls += 1; } } });
  await assert.rejects(() => engine.runTriage(), /PostgreSQL unavailable/);
  await assert.rejects(() => engine.runDispatch(), /PostgreSQL unavailable/);
  assert.equal(runtimeCalls, 0);
});
