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
const bounded = (value, maximum) => Math.max(0, Math.min(maximum, Math.round(value)));
const riskContribution = Object.freeze({ read_only: 0, consequential: 10, human_task: 15 });

function factor(id, contribution, rationale) {
  return { id, contribution: bounded(contribution, complexityFactorWeights[id]), rationale };
}

function providerExplanation(probe) {
  return `Tier ${probe.tier} satisfies capability, availability, risk, confidence, context, and latency gates.`;
}

function routingAudit(evidence) {
  const results = evidence?.routing?.results ?? [];
  const selected = evidence?.selected ?? null;
  const eligible = results.filter((entry) => entry.eligible).map((entry) => ({
    id: entry.provider_id,
    explanation: providerExplanation(entry),
  }));
  return {
    selected_tier: selected?.tier ?? 0,
    eligible_executors: eligible,
    selected_executor_id: selected?.id ?? null,
    explanation: selected
      ? `Existing cheapest-sufficient routing selected ${selected.id} at tier ${selected.tier ?? 1} using tier, capability specificity, and stable provider-ID tie-breakers; complexity does not change eligibility or selection.`
      : "Existing routing found no eligible executor; the complexity score does not grant execution authority.",
  };
}

function textSize(workItems) {
  return workItems.reduce((total, work) => total + Buffer.byteLength(`${work.title ?? ""}\n${work.outcome ?? ""}`), 0);
}

/**
 * Deterministically score normalized request or package structure. This consumes
 * the authoritative routing result; it never selects or makes a provider
 * eligible. No timestamps, identifiers, object key order, or model-authored
 * score values affect the result.
 */
export function computeComplexityScore({ work_items: workItems, dependencies = [], execution_confidence: confidence = 1,
  sufficient_context: sufficientContext = true, questions = [], routing_evidence: routingEvidence,
  internal_dependencies: internalDependencies = 0, resource_requirements: resourceRequirements = {} }) {
  const works = workItems ?? [];
  const criteria = works.flatMap((work) => work.acceptance_criteria ?? []);
  const verificationIds = new Set(criteria.flatMap((criterion) => criterion.verification_ids ?? []));
  const capabilities = new Set(works.flatMap((work) => work.required_capabilities ?? []));
  const repositoryPackages = works.filter((work) => work.repository_required).length;
  const highestRisk = Math.max(0, ...works.map((work) => riskContribution[work.action_class] ?? 0));
  const selectedTier = routingEvidence?.selected?.tier ?? null;
  const contextBytes = textSize(works);
  const resources = Object.keys(resourceRequirements ?? {}).sort();

  const scope = bounded(works.length * 3 + Math.ceil(textSize(works) / 500) * 2
    + Math.min(4, criteria.length) + Math.min(4, capabilities.size * 2) + Math.min(4, repositoryPackages * 2), 20);
  const ambiguity = bounded((1 - Math.max(0, Math.min(1, confidence))) * 10
    + (sufficientContext ? 0 : 5) + Math.min(5, questions.length * 2), 15);
  const dependency = bounded(dependencies.length * 3 + internalDependencies * 2, 15);
  const verification = bounded(verificationIds.size * 3 + Math.min(4, criteria.length) + Math.min(2, repositoryPackages * 2), 15);
  const capability = selectedTier === null ? 10 : selectedTier <= 0 ? 0 : selectedTier === 1 ? 2 : selectedTier === 2 ? 7 : 10;
  const resource = bounded((selectedTier ?? 3) * 3 + (contextBytes > 65_536 ? 4 : contextBytes > 16_384 ? 2 : 0)
    + Math.min(4, resources.length * 2), 10);
  const factors = [
    factor("scope", scope, `${works.length} package(s), ${criteria.length} acceptance criterion/criteria, ${capabilities.size} required capability/capabilities, and ${repositoryPackages} repository package(s).`),
    factor("ambiguity", ambiguity, `Execution confidence is ${confidence}; sufficient_context is ${Boolean(sufficientContext)} and ${questions.length} question(s) remain.`),
    factor("dependencies", dependency, `${dependencies.length} external and ${internalDependencies} decomposition dependency edge(s).`),
    factor("risk", highestRisk, `Highest normalized action class is ${works.some((work) => work.action_class === "human_task") ? "human_task" : works.some((work) => work.action_class === "consequential") ? "consequential" : "read_only"}.`),
    factor("verification_burden", verification, `${verificationIds.size} configured check(s), ${criteria.length} criterion/criteria, and ${repositoryPackages} repository package(s) require verification.`),
    factor("local_executor_capability", capability, selectedTier === null
      ? "No executor satisfies the current authoritative routing gates."
      : `Cheapest-sufficient routing selected tier ${selectedTier}; tier 0 is mechanical, tier 1 local, and higher tiers represent a larger local capability gap.`),
    factor("resource_cost", resource, `${contextBytes} normalized work-text byte(s), ${resources.length} counted resource type(s), and selected tier ${selectedTier ?? "unavailable"} provide a non-USD resource proxy.`),
  ];
  const score = factors.reduce((sum, entry) => sum + entry.contribution, 0);
  const routing = routingAudit(routingEvidence);
  const result = {
    score,
    factors,
    rationale: `Fixed integer factor contributions sum to ${score}/100 from normalized request and policy evidence.`,
    routing,
    predicted_cost: {
      cost_usd: null,
      basis: `No trusted USD estimate is configured; resource-cost contribution is ${resource}/10 and routing tier is ${routing.selected_tier}.`,
    },
    actual_outcome: null,
  };
  return validateComplexityScore(result);
}

/** Build a request audit from independently scored executable packages. */
export function computeRequestComplexity(decision, packageScores) {
  const selected = packageScores.map((entry) => entry.routing.selected_executor_id).filter(Boolean);
  const tiers = packageScores.map((entry) => entry.routing.selected_tier);
  const eligible = new Map();
  for (const entry of packageScores) {
    for (const executor of entry.routing.eligible_executors) eligible.set(executor.id, executor);
  }
  const representative = {
    selected: selected.length ? { id: selected[0], tier: Math.max(0, ...tiers) } : null,
    routing: { results: [...eligible.values()].map((entry) => ({ provider_id: entry.id, tier: tiers[0] ?? 0, eligible: true })) },
  };
  const result = computeComplexityScore({
    work_items: decision.work_items,
    dependencies: decision.dependencies,
    execution_confidence: decision.execution_confidence,
    sufficient_context: decision.sufficient_context,
    questions: decision.questions,
    routing_evidence: representative,
    internal_dependencies: Math.max(0, decision.work_items.length - 1),
    resource_requirements: decision.resource_requirements,
  });
  result.routing.selected_tier = Math.max(0, ...tiers);
  result.routing.eligible_executors = [...eligible.values()].sort((left, right) => left.id.localeCompare(right.id));
  result.routing.selected_executor_id = packageScores.length === 1 ? representative.selected?.id ?? null : null;
  result.routing.explanation = packageScores.length > 1
    ? "The request is decomposed; each package retains its authoritative cheapest-sufficient selection, so no single request-level executor is implied."
    : packageScores[0]?.routing.explanation ?? result.routing.explanation;
  result.predicted_cost.basis = `No trusted USD estimate is configured; request resource-cost contribution is ${result.factors.find((entry) => entry.id === "resource_cost").contribution}/10 across ${packageScores.length} package(s).`;
  return validateComplexityScore(result);
}

function availableActualCost(attempts) {
  const values = (attempts ?? []).map((attempt) => attempt.execution?.actual_cost_usd
    ?? attempt.execution?.usage?.cost_usd ?? attempt.execution?.output?.actual_cost_usd).filter(finiteNonnegative);
  return values.length ? Number(values.reduce((sum, value) => sum + value, 0).toFixed(8)) : null;
}

/** Record only compact terminal evidence; never retain arbitrary provider output. */
export function recordComplexityOutcome(data, job, status, summary) {
  if (!job?.work?.complexity) return;
  const costUsd = availableActualCost(job.attempts);
  job.work.complexity.actual_outcome = { status, cost_usd: costUsd, summary };
  const parent = data.items?.[job.parent_id];
  const index = parent?.job_ids?.indexOf(job.id) ?? -1;
  if (index >= 0 && parent.decision?.work_items?.[index]?.complexity) {
    parent.decision.work_items[index].complexity.actual_outcome = structuredClone(job.work.complexity.actual_outcome);
  }
  const jobs = (parent?.job_ids ?? []).map((id) => data.jobs[id]).filter(Boolean);
  const requestBlocked = jobs.some((entry) => entry.state === "Blocked");
  if (!parent?.decision?.complexity || jobs.length === 0
    || (!requestBlocked && jobs.some((entry) => entry.state !== "Shipped"))) return;
  const outcomes = jobs.map((entry) => entry.work?.complexity?.actual_outcome).filter(Boolean);
  const costs = outcomes.map((entry) => entry.cost_usd);
  parent.decision.complexity.actual_outcome = {
    status: requestBlocked ? "blocked" : "shipped",
    cost_usd: costs.length === jobs.length && costs.every(finiteNonnegative)
      ? Number(costs.reduce((sum, value) => sum + value, 0).toFixed(8)) : null,
    summary: requestBlocked
      ? `${jobs.filter((entry) => entry.state === "Blocked").length} of ${jobs.length} package(s) ended blocked.`
      : `${jobs.length} package(s) reached verified delivery.`,
  };
}

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
