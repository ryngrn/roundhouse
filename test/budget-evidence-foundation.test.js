import assert from "node:assert/strict";
import test from "node:test";
import { budgetApprovalValid, evaluatePaidDispatch, normalizePaidUsage,
  paidUsageSummary, reportedPaidUsage } from "../src/workflow/budgets.js";

const provider = () => ({
  id: "paid-executor", paid: true,
  estimate: { paid_tokens: 1000, paid_dollars: 2 },
  budget: { hard_paid_dollars: 5, soft_paid_tokens: 1500 },
});
const project = () => ({
  id: "roundhouse", budget: { soft_paid_dollars: 1, hard_paid_dollars: 4 },
});
const job = () => ({
  id: "job-1", parent_id: "item-1", project_id: "roundhouse", revision: 3,
  input_digest: "input-1", policy_hash: "policy-1", attempts: [],
});
const data = () => ({
  items: { "item-1": { id: "item-1", revision: 7 } },
  jobs: { "job-1": job() },
});

test("paid usage never accepts negative or nonfinite readings", () => {
  assert.deepEqual(normalizePaidUsage({ paid_tokens: -5, paid_dollars: Infinity }),
    { paid_tokens: 0, paid_dollars: 0 });
  assert.deepEqual(normalizePaidUsage({ paid_tokens: 50, paid_dollars: 0.1 }),
    { paid_tokens: 50, paid_dollars: 0.1 });
  assert.deepEqual(reportedPaidUsage({ output: { usage: { total_tokens: 500, cost_usd: 0.4 } } }),
    { paid_tokens: 500, paid_dollars: 0.4 });
});

test("soft budgets flag warnings but do not silently block work", () => {
  const s = data(), j = s.jobs["job-1"];
  const outcome = evaluatePaidDispatch({ data: s, project: project(),
    provider: provider(), job: j, attempt: 1, at: "2026-10-08T12:00:00Z" });
  assert.equal(outcome.decision, "soft_limit_allowed");
  assert.deepEqual(outcome.soft_exceeded, [{ scope: "project", dimension: "paid_dollars" }]);
  assert.deepEqual(outcome.hard_exceeded, []);
  assert.ok(outcome.scope_digest);
});

test("provider and project hard limits require explicit approval", () => {
  const s = data(), j = s.jobs["job-1"];
  s.jobs.previous = { id: "previous", project_id: "roundhouse",
    attempts: [{ run: { provider_id: "paid-executor" },
      paid_usage: { estimate: { paid_tokens: 200, paid_dollars: 4 } } }] };
  const result = evaluatePaidDispatch({ data: s, project: project(),
    provider: provider(), job: j, attempt: 1 });
  assert.equal(result.decision, "approval_required");
  assert.deepEqual(result.hard_exceeded.map(x => x.scope), ["provider", "project"]);
  assert.equal(budgetApprovalValid(j, result, s.items["item-1"]), false);
  const scoped = { ...j,
    budget_gate: { scope_digest: result.scope_digest, job_revision: j.revision, item_revision: 7 },
    budget_approval: { scope_digest: result.scope_digest, job_revision: j.revision,
      item_revision: 7, actor: "operator", approved_at: "2026-10-08T12:01:00Z" },
  };
  assert.equal(budgetApprovalValid(scoped, result, s.items["item-1"]), true);
  assert.equal(budgetApprovalValid({ ...scoped, revision: 4 }, result, s.items["item-1"]), false);
  assert.equal(budgetApprovalValid(scoped, result, { revision: 8 }), false);
});

test("other-job pending estimates reserve budget before actual spending", () => {
  const s = data(), j = s.jobs["job-1"];
  s.jobs.pending = { id: "pending", project_id: "roundhouse", attempts: [],
    pre_dispatch_budget: { status: "reserved", provider_id: "paid-executor",
      estimate: { paid_tokens: 200, paid_dollars: 3.5 } } };
  const result = evaluatePaidDispatch({ data: s, project: project(),
    provider: provider(), job: j, attempt: 1 });
  assert.equal(result.decision, "approval_required");
  assert.deepEqual(result.accounted_reservations, { provider: ["pending"], project: ["pending"] });
  assert.equal(result.provider.current.paid_dollars, 3.5);
  assert.equal(result.project.projected.paid_dollars, 5.5);
});

test("actual usage replaces estimates in accounting without duplicate billing", () => {
  const s = data();
  s.jobs["job-1"].attempts = [{ run: { provider_id: "paid-executor" },
    paid_usage: { evaluation: { paid: true },
      estimate: { paid_tokens: 1000, paid_dollars: 2 },
      actual: { paid_tokens: 350, paid_dollars: 0.7 } } }];
  const summary = paidUsageSummary(s);
  assert.equal(summary.attempts, 1);
  assert.deepEqual(summary.estimated, { paid_tokens: 1000, paid_dollars: 2 });
  assert.deepEqual(summary.accounted, { paid_tokens: 350, paid_dollars: 0.7 });
});
