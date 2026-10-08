import assert from "node:assert/strict";
import test from "node:test";
import { complexityFactorWeights, computeComplexityScore, computeRequestComplexity, recordComplexityOutcome,
  validateComplexityScore } from "../src/workflow/complexity-score.js";
import { validateDecision } from "../src/workflow/decision.js";

const score = (changes = {}) => ({
  score: 48,
  factors: Object.entries(complexityFactorWeights).map(([id, weight]) => ({
    id, contribution: Math.floor(weight / 2), rationale: `${id} evidence`,
  })),
  rationale: "The fixed factors sum to a moderate score.",
  routing: { selected_tier: 1, eligible_executors: [{ id: "local", explanation: "Capabilities and policy gates pass." }],
    selected_executor_id: "local", explanation: "Tier 1 is the cheapest eligible tier." },
  predicted_cost: { cost_usd: 0, basis: "Configured local execution." },
  actual_outcome: null,
  ...changes,
});

function decision(complexity, workComplexity) {
  return {
    project: "example", project_confidence: 1, execution_confidence: 1, sufficient_context: true,
    safe_to_execute: true, approval_required: false, decision: "execute", reason: "Complete input.", questions: [],
    question: null, decision_key: null, dependencies: [], executor: "codex", runtime: "local",
    shipping_policy: "push_branch", should_decompose: false, reconcile_with: null, blocked_on: [], complexity,
    work_items: [{ title: "One package", outcome: "A bounded result.", repository_required: true,
      required_capabilities: [], action_class: "read_only", schedule: null, complexity: workComplexity,
      acceptance_criteria: [{ description: "Tests pass.", verification_ids: ["tests"] }] }],
  };
}

test("complexity scores retain complete request and work-package audit records", () => {
  const requestScore = score();
  const workScore = score({ score: 20,
    factors: Object.entries(complexityFactorWeights).map(([id]) => ({ id, contribution: id === "scope" ? 20 : 0, rationale: `${id} evidence` })),
    actual_outcome: { status: "shipped", cost_usd: 0, summary: "Verified and delivered." } });
  const value = validateDecision(decision(requestScore, workScore));
  assert.equal(value.complexity.score, 48);
  assert.equal(value.work_items[0].complexity.actual_outcome.status, "shipped");
});

test("complexity validation rejects incomplete, inconsistent, and unexplainable records", () => {
  const incomplete = score();
  delete incomplete.predicted_cost;
  assert.throws(() => validateComplexityScore(incomplete), /predicted_cost is required/);
  assert.throws(() => validateComplexityScore(score({ score: 47 })), /sum of factor contributions/);
  assert.throws(() => validateComplexityScore(score({ factors: score().factors.slice(1) })), /all seven/);
  assert.throws(() => validateComplexityScore(score({ routing: { ...score().routing, selected_executor_id: "paid" } })), /eligible executor/);
  assert.throws(() => validateComplexityScore(score({ predicted_cost: { cost_usd: -1, basis: "estimate" } })), /nonnegative nullable/);
  assert.throws(() => validateComplexityScore(score({ actual_outcome: { status: "done", cost_usd: -1, summary: "bad" } })), /valid outcome/);
});

test("legacy decision providers remain compatible when score records are absent", () => {
  const legacy = decision(null, null);
  delete legacy.complexity;
  delete legacy.work_items[0].complexity;
  const value = validateDecision(legacy);
  assert.equal(value.complexity, null);
  assert.equal(value.work_items[0].complexity, null);
});

const packageWork = (changes = {}) => ({ title: "Implement bounded behavior", outcome: "A verified result.",
  repository_required: true, required_capabilities: ["artifact"], action_class: "read_only",
  acceptance_criteria: [{ description: "Tests pass.", verification_ids: ["tests"] }], ...changes });
const evidence = {
  selected: { id: "local", tier: 1 },
  routing: { results: [
    { provider_id: "mechanical", tier: 0, eligible: false },
    { provider_id: "local", tier: 1, eligible: true },
    { provider_id: "paid", tier: 2, eligible: true },
  ] },
};

test("normalized inputs produce stable deterministic scores and routing explanations", () => {
  const input = { work_items: [packageWork()], dependencies: ["prior-job"], execution_confidence: 0.8,
    sufficient_context: true, questions: [], routing_evidence: evidence, resource_requirements: { gpu: 1 } };
  const first = computeComplexityScore(input);
  const second = computeComplexityScore(structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(first.score, first.factors.reduce((sum, factor) => sum + factor.contribution, 0));
  assert.deepEqual(first.factors.map((factor) => factor.id), Object.keys(complexityFactorWeights));
  assert.equal(first.routing.selected_executor_id, "local");
  assert.deepEqual(first.routing.eligible_executors.map((executor) => executor.id), ["local", "paid"]);
  assert.equal(first.predicted_cost.cost_usd, null);
  assert.match(first.predicted_cost.basis, /No trusted USD estimate/);
});

test("decomposition retains an independent score for every executable package", () => {
  const works = [packageWork(), packageWork({ title: "Second package", required_capabilities: [] })];
  const scores = works.map((work) => computeComplexityScore({ work_items: [work], routing_evidence: evidence }));
  const whole = computeRequestComplexity({ work_items: works, dependencies: [], execution_confidence: 1,
    sufficient_context: true, questions: [] }, scores);
  assert.equal(scores.length, works.length);
  assert.ok(scores.every((entry) => entry.factors.every((factor) => factor.rationale)));
  assert.equal(whole.routing.selected_executor_id, null);
  assert.match(whole.routing.explanation, /each package/);
});

test("terminal audit outcomes use available numeric cost without retaining provider payloads", () => {
  const workComplexity = computeComplexityScore({ work_items: [packageWork()], routing_evidence: evidence });
  const data = { items: { item: { job_ids: ["item-1"], decision: { complexity: structuredClone(workComplexity),
    work_items: [{ ...packageWork(), complexity: structuredClone(workComplexity) }] } } }, jobs: {} };
  const job = { id: "item-1", parent_id: "item", state: "Shipped", work: { ...packageWork(), complexity: workComplexity },
    attempts: [{ execution: { usage: { cost_usd: 0.125, secret: "not retained" } } }] };
  data.jobs[job.id] = job;
  recordComplexityOutcome(data, job, "shipped", "Verified delivery was confirmed.");
  assert.deepEqual(job.work.complexity.actual_outcome,
    { status: "shipped", cost_usd: 0.125, summary: "Verified delivery was confirmed." });
  assert.equal(data.items.item.decision.complexity.actual_outcome.cost_usd, 0.125);
  assert.equal(JSON.stringify(job.work.complexity).includes("secret"), false);
});
