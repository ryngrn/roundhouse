import test from "node:test";
import assert from "node:assert/strict";
import { executionOutcomeMetrics } from "../src/workflow/execution-metrics.js";
import { statusView } from "../src/workflow/views.js";

const at = "2026-10-08T12:00:00.000Z";
const link = (suffix) => ({ uri: `roundhouse://evidence/${suffix}` });
const provenance = Object.fromEntries(["intake", "dispatch", "executor_ownership", "verification", "delivery"]
  .map((stage) => [stage, { recorded_at: at, evidence_links: [link(stage)] }]));

function outcome(classification, overrides = {}) {
  const native = classification === "native_success";
  const exception = classification === "exception_success";
  const interventions = overrides.human_intervention_count ?? (native ? 0 : 1);
  return {
    schema_version: 1,
    classification,
    recorded_at: overrides.recorded_at ?? at,
    recorded_by: "test",
    historical_import: false,
    execution_path: [{ kind: "local_codex", provider: "local-project", runtime: "local", ...overrides.path }],
    provenance: native ? provenance : {},
    reason: native ? null : { code: overrides.reason ?? "stale_worker", note: "Structured test reason." },
    exception_expected: exception ? (overrides.expected ?? false) : null,
    human_intervention_required: interventions > 0,
    human_intervention_count: interventions,
    human_minutes: overrides.human_minutes ?? null,
    evidence_links: [link(classification)],
  };
}

function job(id, classification, overrides = {}) {
  const successful = classification !== "failed_or_abandoned";
  return {
    id,
    parent_id: overrides.parent_id ?? `item-${id}`,
    project_id: overrides.project_id ?? "roundhouse",
    state: successful ? "Shipped" : "Blocked",
    agent_role: overrides.agent_role ?? "general",
    work: { title: id, action_class: overrides.action_class ?? "consequential" },
    execution_outcome: outcome(classification, overrides),
  };
}

test("execution metrics aggregate classifications, exception reasons, interventions, dimensions, and trends", () => {
  const jobs = {
    native: job("native", "native_success", { recorded_at: "2026-10-07T12:00:00Z" }),
    recovered: job("recovered", "recovered_success", { human_intervention_count: 2, human_minutes: 10,
      path: { kind: "herdr_claude", provider: "claude-team", runtime: "herdr", machine: "iMac" } }),
    bypassed: job("bypassed", "exception_success", { reason: "missing_capability", expected: false,
      human_intervention_count: 1, human_minutes: 5, project_id: "inclusion", action_class: "human_task",
      path: { kind: "manual_rdc", provider: "operator", runtime: "out_of_band", machine: "Studio" } }),
    failed: job("failed", "failed_or_abandoned", { reason: "provider_limit", human_intervention_count: 0 }),
  };
  const metrics = executionOutcomeMetrics({ jobs });

  assert.deepEqual(metrics.classification_counts, {
    native_success: 1, recovered_success: 1, exception_success: 1, failed_or_abandoned: 1,
  });
  assert.equal(metrics.kpis.tasks_completed_without_intervention.numerator, 1);
  assert.equal(metrics.kpis.tasks_completed_without_intervention.denominator, 3);
  assert.equal(metrics.kpis.tasks_completed_without_intervention.rate, 1 / 3);
  assert.ok(Math.abs(metrics.kpis.tasks_completed_without_intervention.percentage - (100 / 3)) < Number.EPSILON * 100);
  assert.deepEqual(metrics.kpis.recovered_vs_bypassed,
    { denominator: 2, recovered_count: 1, bypassed_count: 1, recovered_share: 0.5, bypassed_share: 0.5,
      recovered_share_of_completed: 1 / 3, bypassed_share_of_completed: 1 / 3 });
  assert.deepEqual(metrics.exception_reasons, [{ reason: "missing_capability", count: 1, share: 1 }]);
  assert.deepEqual(metrics.exception_expectation, { expected: 0, unexpected: 1 });
  assert.equal(metrics.interventions.average_per_completed_job, 1);
  assert.equal(metrics.interventions.median_per_completed_job, 1);
  assert.deepEqual(metrics.interventions.human_minutes,
    { reported_jobs: 2, total: 15, average_per_reported_job: 7.5, median_per_reported_job: 7.5 });
  assert.equal(metrics.dimensions.project.find((entry) => entry.value === "inclusion").exception_rate, 1);
  assert.equal(metrics.dimensions.executor.find((entry) => entry.value === "manual_rdc").exception_count, 1);
  assert.equal(metrics.dimensions.provider.find((entry) => entry.value === "operator").exception_count, 1);
  assert.equal(metrics.dimensions.executor_provider.find((entry) => entry.value === "manual_rdc / operator").exception_count, 1);
  assert.equal(metrics.dimensions.machine_runtime.find((entry) => entry.value === "Studio / out_of_band").exception_rate, 1);
  assert.equal(metrics.dimensions.job_type.find((entry) => entry.value === "human_task").exception_rate, 1);
  assert.deepEqual(metrics.trends.daily.map((entry) => entry.period), ["2026-10-07", "2026-10-08"]);
  assert.deepEqual(metrics.trends.monthly.map((entry) => entry.period), ["2026-10"]);
});

test("trustworthy completion KPI excludes imported, unclassified, and Shipped-only jobs", () => {
  const native = job("native", "native_success");
  const imported = job("imported", "exception_success");
  imported.execution_outcome.historical_import = true;
  const jobs = {
    native,
    imported,
    legacy: { id: "legacy", parent_id: "item-legacy", project_id: "roundhouse", state: "Shipped", work: { title: "Legacy" } },
  };
  const metrics = executionOutcomeMetrics({ jobs });
  assert.deepEqual(metrics.population, {
    total_jobs: 3,
    measured_jobs: 1,
    completed_jobs: 1,
    excluded_jobs: 2,
    exclusions: { historical_import: 1, unclassified: 1 },
  });
  assert.equal(metrics.kpis.tasks_completed_without_intervention.percentage, 100);
  assert.equal(metrics.classification_counts.native_success, 1);
  assert.equal(metrics.drill_down.length, 1);
  assert.equal("machine" in metrics.drill_down[0].execution_path[0], false);
  assert.deepEqual(Object.keys(metrics.drill_down[0].provenance).sort(),
    ["delivery", "dispatch", "executor_ownership", "intake", "verification"]);
  assert.equal("human_minutes" in metrics.drill_down[0], true);
  assert.equal(metrics.drill_down[0].human_minutes, null);
});

test("status read model exposes scoped authoritative execution KPIs", () => {
  const jobs = {
    alpha: job("alpha", "native_success", { parent_id: "item-alpha", project_id: "alpha" }),
    beta: job("beta", "exception_success", { parent_id: "item-beta", project_id: "beta", reason: "herdr_failure" }),
  };
  for (const value of Object.values(jobs)) Object.assign(value, { attempts: [], history: [] });
  const item = (id, project, jobId) => ({ id, state: "Shipped", revision: 1, project_id: project,
    input: { text: id }, history: [], questions: [], job_ids: [jobId] });
  const data = { jobs, items: { "item-alpha": item("item-alpha", "alpha", "alpha"),
    "item-beta": item("item-beta", "beta", "beta") }, projects: {}, outbox: [] };

  const status = statusView(data, { project_id: "alpha" });
  assert.equal(status.execution_metrics.population.total_jobs, 1);
  assert.equal(status.execution_metrics.kpis.tasks_completed_without_intervention.percentage, 100);
  assert.equal(status.execution_metrics.classification_counts.exception_success, 0);
});
