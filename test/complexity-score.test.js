import assert from "node:assert/strict";
import test from "node:test";
import { complexityFactorWeights, validateComplexityScore } from "../src/workflow/complexity-score.js";
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
