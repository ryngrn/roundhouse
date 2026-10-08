import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transitions, record, transition } from "../src/workflow/state.js";
import { validateDecision, routeDecision } from "../src/workflow/decision.js";
import { Store, acquireLock } from "../src/workflow/store.js";
import { runProcess } from "../src/workflow/runtime.js";
import { actionPolicy, assertProviderAuthorized, classifyAction } from "../src/workflow/actions.js";
import { planningSessionView } from "../src/workflow/planning-session.js";
import { depotCommand } from "../src/workflow/cli.js";

const project = { id: "example", status: "active", executor: { kind: "command" }, runtime: "local",
  verification: [{ id: "tests" }], policy: { project_confidence: 0.8, execution_confidence: 0.9, allow_autonomous: true, shipping: "push_branch" } };
const decision = { project: "example", project_confidence: 0.8, execution_confidence: 0.9, sufficient_context: true, safe_to_execute: true,
  approval_required: false, decision: "execute", reason: "Known project and constrained scope.", question: "", decision_key: null,
  dependencies: [], executor: "command", runtime: "local", shipping_policy: "push_branch", should_decompose: false,
  work_items: [{ title: "Change", outcome: "Useful outcome", acceptance_criteria: [{ description: "Tests pass", verification_ids: ["tests"] }] }] };

test("unit: every declared state edge succeeds and undeclared edges fail", () => {
  for (const [from, targets] of Object.entries(transitions)) {
    for (const to of Object.keys(transitions)) {
      const value = record("test", { state: from });
      if (targets.includes(to) || to === "Blocked") { transition(value, to, "test"); assert.equal(value.state, to); assert.equal(value.history.length, 1); }
      else assert.throws(() => transition(value, to, "test"));
    }
  }
});
test("unit: threshold boundaries, authority, configuration routing and readiness", () => {
  assert.equal(routeDecision(decision, [project]).state, "Ready");
  for (const changes of [{ project: null }, { project_confidence: 0.79 }, { execution_confidence: 0.89 }, { sufficient_context: false }, { runtime: "remote" }, { shipping_policy: "deploy" }, { work_items: [] }]) {
    assert.equal(routeDecision({ ...decision, ...changes }, [project]).state, "Needs Clarification");
  }
  for (const changes of [{ approval_required: true }, { safe_to_execute: false }, { decision: "review" }]) assert.equal(routeDecision({ ...decision, ...changes }, [project]).state, "Review");
  assert.equal(routeDecision(decision, [{ ...project, policy: { ...project.policy, allow_autonomous: false } }]).state, "Review");
  assert.equal(routeDecision(decision, [{ ...project, status: "paused" }]).state, "Blocked");
  assert.equal(routeDecision({ ...decision, decision: "archive", project_confidence: 0.95 }, []).state, "Archived");
  assert.equal(routeDecision({ ...decision, decision: "reconcile", project_confidence: 0.95, reconcile_with: "durable-item" }, []).state, "Reconciled");
  assert.equal(routeDecision({ ...decision, decision: "block", blocked_on: ["runtime"] }, []).state, "Blocked");
  assert.equal(routeDecision(decision, [project], "different").state, "Needs Clarification");
  assert.throws(() => validateDecision({ ...decision, project_confidence: 2 }));
  assert.throws(() => validateDecision({ ...decision, private_reasoning: "not allowed" }));
});
test("unit: slice contracts preserve explicit repository and capability requirements", () => {
  const modeled = structuredClone(decision);
  Object.assign(modeled.work_items[0], {
    repository_required: false,
    required_capabilities: ["research", "integration", "scheduling", "artifact", "external-action", "human-task"],
  });
  assert.equal(validateDecision(modeled).work_items[0].repository_required, false);
  assert.deepEqual(modeled.work_items[0].required_capabilities, ["research", "integration", "scheduling", "artifact", "external-action", "human-task"]);
  assert.throws(() => validateDecision({ ...structuredClone(decision), work_items: [{
    ...decision.work_items[0], repository_required: false, required_capabilities: ["Human Task"],
  }] }), /stable lowercase/);
});
test("unit: planning sessions explain durable eligibility, exclusions, and deterministic order", () => {
  const item = (id, state, projectId, rank, createdAt) => ({ id, state, project_id: projectId, priority_rank: rank,
    created_at: createdAt, input: { text: id }, questions: [], job_ids: [], history: [] });
  const data = { items: {
    "alpha-low": item("alpha-low", "Blocked", "alpha", 2, "2026-01-02T00:00:00Z"),
    "alpha-high": item("alpha-high", "Needs Clarification", "alpha", 0, "2026-01-03T00:00:00Z"),
    "beta-high": item("beta-high", "Review", "beta", 0, "2026-01-01T00:00:00Z"),
    ready: item("ready", "Ready", "alpha", 0, "2026-01-01T00:00:00Z"),
    active: item("active", "Decision", "alpha", 0, "2026-01-01T00:00:00Z"),
    depot: item("depot", "Depot", "alpha", 0, "2026-01-01T00:00:00Z"),
    executing: { ...item("executing", "Ready", "beta", 0, "2026-01-01T00:00:00Z"), job_ids: ["executing-job"] },
    shipped: { ...item("shipped", "Ready", "beta", 0, "2026-01-01T00:00:00Z"), job_ids: ["shipped-job"] },
  }, jobs: {
    "executing-job": { id: "executing-job", parent_id: "executing", project_id: "beta", state: "Executing", attempts: [] },
    "shipped-job": { id: "shipped-job", parent_id: "shipped", project_id: "beta", state: "Shipped", attempts: [] },
  } };
  data.items["alpha-high"].questions.push({ id: "question-1", revision: 3, status: "open", prompt: "Choose the target." });

  const before = structuredClone(data);
  const byProject = planningSessionView(data, { mode: "project" });
  const byPriority = planningSessionView(data, { mode: "priority" });

  assert.deepEqual(data, before);
  assert.deepEqual(byProject.entries.map((entry) => entry.entity_id), ["alpha-high", "alpha-low", "beta-high"]);
  assert.deepEqual(byPriority.entries.map((entry) => entry.entity_id), ["alpha-high", "beta-high", "alpha-low"]);
  assert.deepEqual(byProject.entries.map((entry) => entry.ordering.position), [1, 2, 3]);
  assert.equal(byProject.entries[0].eligibility.human_need[0].question_id, "question-1");
  assert.deepEqual(Object.fromEntries(byProject.excluded.map((entry) => [entry.entity_id, entry.code])), {
    ready: "ready_for_dispatch", active: "active_work", depot: "no_human_need",
    "executing-job": "active_work", "shipped-job": "terminal_state",
  });
  assert.throws(() => planningSessionView(data, { mode: "recent" }), /project or priority/);
});
test("unit: planning eligibility follows durable human need and ignores imported legacy workflow labels", () => {
  const item = (id, state, legacyStatus, questions = []) => ({ id, state, project_id: "roundhouse", priority: "P1", priority_rank: 1,
    created_at: "2026-01-01T00:00:00Z", input: { text: id }, questions, job_ids: [], history: [],
    legacy_depot: { Status: legacyStatus, "Workflow State": legacyStatus } });
  const data = { items: {
    imported: item("imported", "Imported Pending", "Running", [{ id: "q1", status: "open", prompt: "Choose the scope." }]),
    ready: item("ready", "Ready", "Needs Decisions", [{ id: "q2", status: "open", prompt: "Stale question." }]),
    depot: item("depot", "Depot", "Ready"),
    review: item("review", "Review", "Running"),
  }, jobs: {} };

  const session = planningSessionView(data, { mode: "project" });

  assert.deepEqual(session.entries.map((entry) => entry.entity_id), ["imported", "review"]);
  assert.deepEqual(session.entries.map((entry) => entry.eligibility.human_need[0].code), ["open_question", "review_state"]);
  assert.deepEqual(Object.fromEntries(session.excluded.map((entry) => [entry.entity_id, entry.code])), {
    ready: "ready_for_dispatch", depot: "no_human_need",
  });
});
test("unit: depot plan starts a read-only text session from authoritative storage", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-plan-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  store.change((data) => {
    data.items.review = { id: "review", state: "Review", project_id: "roundhouse", priority: "P2", priority_rank: 2,
      created_at: "2026-01-01T00:00:00Z", input: { text: "Choose a release window" }, questions: [], job_ids: [], history: [] };
  });
  const before = store.read();

  const session = await depotCommand(["plan", "--state-dir", directory, "--order", "priority"]);

  assert.equal(session.authority, "durable_roundhouse_state");
  assert.equal(session.mode, "priority");
  assert.equal(session.entries[0].item_id, "review");
  assert.equal(session.entries[0].project_id, "roundhouse");
  assert.equal(session.entries[0].priority, "P2");
  assert.match(session.entries[0].eligibility.human_need[0].reason, /human review/);
  assert.equal(session.entries[0].ordering.keys.priority, 2);
  assert.deepEqual(store.read(), before);
});
test("unit: trusted action classification can be elevated but not downgraded", () => {
  assert.equal(classifyAction({ action_class: "consequential", required_capabilities: ["research"] }), "consequential");
  assert.equal(classifyAction({ action_class: "read_only", required_capabilities: ["external-action"] }), "consequential");
  assert.equal(classifyAction({ action_class: "read_only", required_capabilities: ["external-action", "human-task"] }), "human_task");
  const work = { title: "Send", required_capabilities: ["external-action"] };
  const unapproved = actionPolicy(work, "policy");
  assert.equal(unapproved.authorized, false);
  assert.throws(() => assertProviderAuthorized({ work, policy_hash: "policy", action_policy: unapproved }), /requires current revision-bound approval/);
  const approved = actionPolicy(work, "policy", { item_revision: 4, actor: "operator", approved_at: new Date().toISOString(), scope_digest: unapproved.scope_digest });
  assert.equal(approved.authorized, true);
  assert.doesNotThrow(() => assertProviderAuthorized({ work, policy_hash: "policy", action_policy: approved }));
  assert.throws(() => assertProviderAuthorized({ work: { ...work, title: "Changed" }, policy_hash: "policy", action_policy: approved }), /requires current revision-bound approval/);
});
test("unit: idempotent submission, conflicting keys and owner-safe lock release", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-store-"));
  const store = new Store(directory);
  const input = { text: "idea" };
  const first = store.submit(input, "key");
  assert.equal(store.submit(input, "key").id, first.id);
  assert.throws(() => store.submit({ text: "different" }, "key"), /different content/);
  const release = acquireLock(store.workerLock);
  assert.throws(() => acquireLock(store.workerLock), /Locked/);
  assert.ok(fs.existsSync(store.workerLock));
  assert.throws(() => store.recover(), /live/);
  release();
  assert.equal(new Store(directory).read().items[first.id].input.text, "idea");
});
test("unit: process failure, timeout and non-shell argv remain bounded", async () => {
  const failed = await runProcess([process.execPath, "-e", "process.exit(3)"]);
  assert.equal(failed.passed, false);
  assert.equal(failed.exit_code, 3);
  const timeout = await runProcess([process.execPath, "-e", "setInterval(()=>{},1000)"], { timeout: 40 });
  assert.equal(timeout.timed_out, true);
  assert.equal(timeout.passed, false);
  const missing = await runProcess(["roundhouse-missing-command"]);
  assert.equal(missing.passed, false);
});
