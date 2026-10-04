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
