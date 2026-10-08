const stableId = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;

export const complexityFactorWeights = Object.freeze({
  scope: 20,
  ambiguity: 15,
  dependencies: 15,
  risk: 15,
  verification_burden: 15,
  local_executor_capability: 10,
  resource_cost: 10,
});

export const complexityFactorIds = Object.freeze(Object.keys(complexityFactorWeights));

const record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const finiteNonnegative = (value) => Number.isFinite(value) && value >= 0;

/**
 * Validate the compact, durable explanation for one request or independently
 * executable work package. Scoring is deterministic at this boundary: all
 * factors occur exactly once and the published score is their exact sum.
 */
export function validateComplexityScore(value, field = "complexity") {
  if (!record(value)) throw new Error(`${field} must be a score record.`);
  const allowed = new Set(["score", "factors", "rationale", "routing", "predicted_cost", "actual_outcome"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown ${field} field: ${key}`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) throw new Error(`${field}.${key} is required.`);

  if (!Number.isInteger(value.score) || value.score < 0 || value.score > 100) {
    throw new Error(`${field}.score must be an integer from 0–100.`);
  }
  if (!Array.isArray(value.factors) || value.factors.length !== complexityFactorIds.length) {
    throw new Error(`${field}.factors must contain all seven scoring factors.`);
  }
  const factors = new Map();
  for (const [index, factor] of value.factors.entries()) {
    if (!record(factor) || Object.keys(factor).some((key) => !["id", "contribution", "rationale"].includes(key))
      || !Object.hasOwn(factor, "id") || !Object.hasOwn(factor, "contribution") || !Object.hasOwn(factor, "rationale")) {
      throw new Error(`${field}.factors[${index}] must contain only id, contribution, and rationale.`);
    }
    if (!complexityFactorIds.includes(factor.id) || factors.has(factor.id)) {
      throw new Error(`${field}.factors must contain each known factor exactly once.`);
    }
    if (!Number.isInteger(factor.contribution) || factor.contribution < 0
      || factor.contribution > complexityFactorWeights[factor.id]) {
      throw new Error(`${field}.${factor.id} contribution must be an integer from 0–${complexityFactorWeights[factor.id]}.`);
    }
    if (!nonempty(factor.rationale)) throw new Error(`${field}.${factor.id} rationale is required.`);
    factors.set(factor.id, factor.contribution);
  }
  const total = [...factors.values()].reduce((sum, contribution) => sum + contribution, 0);
  if (value.score !== total) throw new Error(`${field}.score must equal the sum of factor contributions.`);
  if (!nonempty(value.rationale)) throw new Error(`${field}.rationale is required.`);

  const routing = value.routing;
  if (!record(routing)) throw new Error(`${field}.routing must be an object.`);
  const routingKeys = ["selected_tier", "eligible_executors", "selected_executor_id", "explanation"];
  if (Object.keys(routing).some((key) => !routingKeys.includes(key)) || routingKeys.some((key) => !Object.hasOwn(routing, key))) {
    throw new Error(`${field}.routing must contain selected_tier, eligible_executors, selected_executor_id, and explanation.`);
  }
  if (!Number.isInteger(routing.selected_tier) || routing.selected_tier < 0 || routing.selected_tier > 100) {
    throw new Error(`${field}.routing.selected_tier must be an integer from 0–100.`);
  }
  if (!Array.isArray(routing.eligible_executors) || routing.eligible_executors.length > 100) {
    throw new Error(`${field}.routing.eligible_executors must be a bounded array.`);
  }
  const eligibleIds = new Set();
  for (const executor of routing.eligible_executors) {
    if (!record(executor) || Object.keys(executor).some((key) => !["id", "explanation"].includes(key))
      || !stableId.test(executor.id ?? "") || !nonempty(executor.explanation) || eligibleIds.has(executor.id)) {
      throw new Error(`${field}.routing.eligible_executors must identify unique executors with explanations.`);
    }
    eligibleIds.add(executor.id);
  }
  if (routing.selected_executor_id !== null && (!stableId.test(routing.selected_executor_id ?? "")
    || !eligibleIds.has(routing.selected_executor_id))) {
    throw new Error(`${field}.routing.selected_executor_id must be null or name an eligible executor.`);
  }
  if (!nonempty(routing.explanation)) throw new Error(`${field}.routing.explanation is required.`);

  const predicted = value.predicted_cost;
  if (!record(predicted) || Object.keys(predicted).some((key) => !["cost_usd", "basis"].includes(key))
    || !Object.hasOwn(predicted, "cost_usd") || !Object.hasOwn(predicted, "basis")
    || (predicted.cost_usd !== null && !finiteNonnegative(predicted.cost_usd)) || !nonempty(predicted.basis)) {
    throw new Error(`${field}.predicted_cost requires a nonnegative nullable cost_usd and basis.`);
  }

  const actual = value.actual_outcome;
  if (actual !== null) {
    if (!record(actual) || Object.keys(actual).some((key) => !["status", "cost_usd", "summary"].includes(key))
      || !stableId.test(actual.status ?? "") || (actual.cost_usd !== null && !finiteNonnegative(actual.cost_usd))
      || !Object.hasOwn(actual, "cost_usd") || !nonempty(actual.summary)) {
      throw new Error(`${field}.actual_outcome must be null or a valid outcome record.`);
    }
  }
  return value;
}

