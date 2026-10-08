import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transitions, record, transition } from "../src/workflow/state.js";
import { computeAdvisory, validateDecision, routeDecision } from "../src/workflow/decision.js";
import { Store, acquireLock } from "../src/workflow/store.js";
import { runProcess } from "../src/workflow/runtime.js";
import { notionInput } from "../src/workflow/cli.js";
import { listIssues, respondToIssue, dispatchHoldReason, needsHumanReview } from "../src/workflow/issues.js";

const project = { id: "example", status: "active", executor: { kind: "command" }, runtime: "local",
  verification: [{ id: "tests" }], policy: { project_confidence: 0.8, execution_confidence: 0.9, allow_autonomous: true, shipping: "push_branch" } };
const decision = { project: "example", project_confidence: 0.8, execution_confidence: 0.9, sufficient_context: true, safe_to_execute: true,
  approval_required: false, decision: "execute", reason: "Known project and constrained scope.", question: "", dependencies: [], executor: "command", runtime: "local", shipping_policy: "push_branch", should_decompose: false,
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
  assert.equal(routeDecision(decision, [project], "different").state, "Needs Clarification");
  assert.throws(() => validateDecision({ ...decision, project_confidence: 2 }));
  assert.throws(() => validateDecision({ ...decision, private_reasoning: "not allowed" }));
});
test("unit: project classification, acceptance criteria, and compute advice remain policy bounded", () => {
  const ambiguous = routeDecision({ ...decision, project: null }, [project]);
  assert.deepEqual({ state: ambiguous.state, refinement: ambiguous.refinement }, { state: "Needs Clarification", refinement: "project" });
  assert.match(ambiguous.question, /Which configured project/);
  const missingCriteria = routeDecision({ ...decision, work_items: [{ ...decision.work_items[0], acceptance_criteria: [] }] }, [project]);
  assert.equal(missingCriteria.refinement, "acceptance_criteria");
  assert.match(missingCriteria.question, /acceptance criteria/i);
  assert.deepEqual(computeAdvisory(project), {
    preference: "local-first", configured_runtime: "local", applicable: true,
    recommendation: "Use the configured local runtime when capacity and policy permit.",
  });
  const remote = computeAdvisory({ ...project, runtime: "herdr" });
  assert.equal(remote.applicable, false);
  assert.equal(remote.configured_runtime, "herdr");
  assert.match(remote.recommendation, /Keep the configured herdr runtime/);
  assert.equal(routeDecision({ ...decision, runtime: "local" }, [{ ...project, runtime: "herdr" }]).state, "Needs Clarification");
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
test("unit: optional goals remain subordinate metadata on project-owned items", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-goal-"));
  const store = new Store(directory);
  const item = store.submit({ text: "idea", project_id: "example", goal_id: "launch" }, "goal-key");
  assert.equal(item.project_id, "example");
  assert.equal(item.goal_id, "launch");
  assert.equal(item.refinement.active_question, null);
  assert.throws(() => store.submit({ text: "idea", goal_id: " " }, "bad-goal"), /goal_id/);
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
test("unit: Notion is a source adapter, and Ready is never an authority grant", () => {
  const input = notionInput({ url: "https://app.notion.com/p/abc", properties: { "Raw Intake": "Original request", Project: { select: { name: "Example" } }, Status: "Ready" } }, [{ id: "example", name: "Example" }]);
  assert.equal(input.text, "Original request");
  assert.equal(input.project_id, "example");
  assert.equal(input.approved, undefined);
  assert.throws(() => notionInput({ url: "https://app.notion.com/p/abc", Project: "Unknown" }, []), /map uniquely/);
});


test("unit: issue resolution is shared, revision guarded and never replays blocked work", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-issues-"));
  const store = new Store(directory);
  const item = store.submit({ text: "Fix build", project_id: "example" }, "issue-base");
  store.change((data) => store.move(data, data.items[item.id], "Blocked", "Verification failed."));
  const initial = listIssues(store.read())[0];
  assert.equal(initial.status, "needs_attention");
  const first = respondToIssue(store, { issueId: item.id, expectedRevision: initial.revision,
    actor: "chat", message: "Investigate the build log" });
  assert.equal(first.status, "investigating");
  assert.equal(listIssues(store.read())[0].history[0].text, "Investigate the build log");
  assert.throws(() => respondToIssue(store, { issueId: item.id, expectedRevision: initial.revision,
    actor: "web", message: "stale" }), /Stale/);
  const repair = respondToIssue(store, { issueId: item.id, expectedRevision: first.revision,
    actor: "web", message: "Please investigate without replaying", action: "replan" });
  assert.ok(repair.follow_up_id);
  const data = store.read();
  assert.equal(data.items[item.id].state, "Blocked");
  assert.equal(data.items[repair.follow_up_id].state, "Depot");
  assert.equal(data.items[repair.follow_up_id].parent_issue_id, item.id);
  assert.throws(() => respondToIssue(store, { issueId: item.id, expectedRevision: repair.revision,
    actor: "web", message: "duplicate", action: "replan" }), /already exists/);
  assert.deepEqual(listIssues(data, { projectId: "absent" }), []);
});


test("unit: Ready work with unsafe prerequisites is an issue, not executable clearance", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-held-ready-"));
  const store = new Store(directory);
  const parent = store.submit({ text: "Legacy task", project_id: "example" }, "held-ready");
  const config = { projects: [project] };
  store.change((data) => {
    data.jobs.held = record("held", { state: "Ready", parent_id: parent.id,
      project_id: "example", dependencies: ["failed"],
      work: { title: "Legacy work", outcome: "Result", acceptance_criteria: [] }, attempts: [] });
    data.jobs.failed = record("failed", { state: "Blocked", project_id: "example", attempts: [] });
  });
  const data = store.read();
  assert.match(dispatchHoldReason(data.jobs.held, data, config), /Waiting for prerequisite/);
  const issue = listIssues(data, { config }).find((entry) => entry.id === "held");
  assert.equal(issue.held_ready, true);
  assert.equal(issue.status, "needs_attention");
  const plan = respondToIssue(store, { issueId: "held", expectedRevision: issue.revision,
    actor: "chat", action: "replan", message: "Investigate first, preserve evidence", config });
  assert.equal(plan.status, "repair_queued");
  assert.equal(store.read().jobs.held.state, "Blocked");
  assert.equal(store.read().items[plan.follow_up_id].state, "Depot");
  assert.equal(store.read().jobs.held.attempts.length, 0);
});


test("unit: review rolls up blockers and questions but does not replay execution", () => {
  const blocked = { state: "Blocked", history: [{ reason: "Verification failed" }] };
  assert.deepEqual(needsHumanReview(blocked), { required: true, kind: "blocked", reason: "Verification failed" });
  assert.equal(needsHumanReview({ state: "Needs Clarification", refinement: { active_question: { prompt: "What project?" } } }).kind, "clarification");
  assert.equal(needsHumanReview({ state: "Review" }).kind, "approval");
  assert.equal(needsHumanReview({ state: "Depot" }).required, false);
  assert.equal(needsHumanReview({ state: "Executing" }).required, false);
  assert.equal(needsHumanReview({ state: "Ready" }, { dispatchHold: "Waiting for prerequisite job-1 (Ready)." }).required, false);
  assert.equal(needsHumanReview({ state: "Ready" }, { dispatchHold: "Waiting for prerequisite job-1 (Blocked)." }).kind, "blocked");
  assert.equal(needsHumanReview({ state: "Ready" }, { dispatchHold: "Project policy changed." }).required, true);
  assert.equal(blocked.state, "Blocked");
});
