import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/workflow/engine.js";
import { deriveExecutionOutcome, executionOutcomeMetricStatus, nativeProvenanceStages } from "../src/workflow/execution-outcome.js";
import { Store } from "../src/workflow/store.js";
import { statusView } from "../src/workflow/views.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/execution-outcome-scenarios.json", import.meta.url), "utf8"));

function itemFor(scenario) {
  return {
    id: `item-${scenario.id}`,
    state: scenario.kind === "failed" ? "Blocked" : "Ready",
    revision: 1,
    project_id: fixture.project_id,
    created_at: fixture.recorded_at,
    updated_at: fixture.recorded_at,
    input: { text: `Outcome telemetry fixture: ${scenario.id}`, project_id: fixture.project_id },
    questions: [],
    history: [],
    job_ids: [scenario.id],
  };
}

function completedLifecycle(scenario) {
  const remote = scenario.runtime === "herdr" ? {
    remote_execution: { runtime: "herdr", machine_selector: scenario.machine },
  } : {};
  const attempt = {
    number: 1,
    started_at: fixture.recorded_at,
    finished_at: fixture.recorded_at,
    status: "completed",
    run: { id: `run-${scenario.id}`, provider_id: `provider-${scenario.id}`, status: "completed" },
    provider_evidence: {
      selected: { id: `provider-${scenario.id}`, kind: scenario.executor },
      invoked: { id: `provider-${scenario.id}`, kind: scenario.executor },
      invoked_at: fixture.recorded_at,
    },
    execution: remote,
    verification: { passed: true, at: fixture.recorded_at, checks: [] },
  };
  return {
    id: scenario.id,
    parent_id: `item-${scenario.id}`,
    project_id: fixture.project_id,
    state: "Shipped",
    revision: 5,
    created_at: fixture.recorded_at,
    updated_at: fixture.recorded_at,
    work: { title: scenario.id, job_type: scenario.kind },
    project_context: {
      runtime: scenario.runtime,
      executor: { kind: scenario.executor },
      ...(scenario.machine ? { herdr: { machine: scenario.machine } } : {}),
    },
    attempts: [attempt],
    history: [
      { from: "Ready", to: "Executing", at: fixture.recorded_at, reason: "Fixture claim recorded." },
      { from: "Verification", to: "Shipped", at: fixture.recorded_at, reason: "Fixture delivery recorded." },
    ],
    delivery_intent: { reconciliation: { status: "confirmed", confirmed_at: fixture.recorded_at } },
    shipping: {
      provider: "git",
      policy: "push_branch",
      branch: `codex/roundhouse-${scenario.id}`,
      pushed: true,
      timestamp: fixture.recorded_at,
      commit: scenario.id.padEnd(40, "0").slice(0, 40),
      verification: attempt.verification,
    },
  };
}

function initialJob(scenario) {
  if (["native", "reconciled"].includes(scenario.kind)) {
    const job = completedLifecycle(scenario);
    if (scenario.kind === "reconciled") {
      job.reconciliation = {
        status: "confirmed",
        confirmed_at: fixture.recorded_at,
        reason: scenario.reason,
        human_intervention_count: 1,
      };
    }
    return job;
  }
  const base = {
    id: scenario.id,
    parent_id: `item-${scenario.id}`,
    project_id: fixture.project_id,
    revision: 4,
    created_at: fixture.recorded_at,
    updated_at: fixture.recorded_at,
    work: { title: scenario.id, job_type: scenario.kind },
    attempts: [],
    history: [],
  };
  if (scenario.kind === "exception_annotation") {
    return { ...base, state: "Blocked", history: [{ from: "Ready", to: "Blocked", at: fixture.recorded_at,
      reason: "Configured execution could not complete the native application step." }] };
  }
  if (scenario.kind === "failed") {
    return { ...base, state: "Blocked", hold: { code: "provider_limit", reason: scenario.reason },
      history: [{ from: "Executing", to: "Blocked", at: fixture.recorded_at, reason: scenario.reason }] };
  }
  if (scenario.kind === "historical_import") {
    return { ...base, state: "Shipped", execution_outcome_exclusion: "historical_import",
      history: [{ from: "Imported History", to: "Shipped", at: fixture.recorded_at, reason: "Imported before measurement." }] };
  }
  return { ...base, state: "Shipped",
    history: [{ from: "Verification", to: "Shipped", at: fixture.recorded_at, reason: "Legacy state without path evidence." }] };
}

test("execution outcome acceptance fixture proves lifecycle classification, exception annotation, metrics, and Control Room projection", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-outcome-acceptance-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  store.change((data) => {
    data.projects[fixture.project_id] = { active: false, blocked: false };
    for (const scenario of fixture.scenarios) {
      const item = itemFor(scenario);
      const job = initialJob(scenario);
      data.items[item.id] = item;
      data.jobs[job.id] = job;
      if (!["historical_import", "unclassified_shipped"].includes(scenario.kind)) {
        job.execution_outcome = deriveExecutionOutcome(job, item);
      }
    }
  });

  const exceptionScenario = fixture.scenarios.find((scenario) => scenario.kind === "exception_annotation");
  const engine = new Engine({ store, config: { projects: [], execution: {} } });
  const exception = engine.annotateExceptionCompletion(exceptionScenario.id, 4, {
    annotation_id: "fixture-rdc-completion",
    actor: "fixture-operator",
    expected: exceptionScenario.expected,
    reason: { code: exceptionScenario.reason_code, note: exceptionScenario.reason },
    execution_path: [{ kind: "manual_rdc", machine: "studio", detail: "Operator completed the native-app step." }],
    evidence_links: [{ kind: "screenshot", uri: "roundhouse://fixture/manual-rdc/completion" }],
    human_intervention_count: exceptionScenario.human_intervention_count,
    human_minutes: exceptionScenario.human_minutes,
  });
  assert.equal(exception.execution_outcome.classification, exceptionScenario.expected_classification);
  assert.equal(exception.shipping.policy, "exception_annotation");
  assert.equal(exception.shipping.pushed, false, "annotation records evidence but never ships or pushes");

  const state = store.read();
  for (const scenario of fixture.scenarios.filter((candidate) => candidate.expected_classification)) {
    assert.equal(state.jobs[scenario.id].execution_outcome.classification, scenario.expected_classification, scenario.id);
  }
  const recovered = state.jobs["recovered-herdr"].execution_outcome;
  assert.equal(recovered.execution_path[0].kind, "herdr_claude");
  assert.equal(recovered.execution_path.at(-1).kind, "operator_reconciliation");
  assert.equal(recovered.reason.code, "stale_worker");
  assert.deepEqual(Object.keys(state.jobs["native-local"].execution_outcome.provenance).sort(),
    [...nativeProvenanceStages].sort());
  assert.equal(state.jobs["manual-rdc"].execution_outcome.provenance.executor_ownership, undefined);

  for (const scenario of fixture.scenarios.filter((candidate) => candidate.expected_exclusion)) {
    assert.equal(executionOutcomeMetricStatus(state.jobs[scenario.id]).reason, scenario.expected_exclusion, scenario.id);
  }

  const overview = statusView(state);
  const metrics = overview.execution_metrics;
  assert.deepEqual(metrics.classification_counts, fixture.expected_metrics.classification_counts);
  assert.deepEqual(metrics.population, {
    total_jobs: fixture.expected_metrics.total_jobs,
    measured_jobs: fixture.expected_metrics.measured_jobs,
    completed_jobs: fixture.expected_metrics.completed_jobs,
    excluded_jobs: fixture.expected_metrics.excluded_jobs,
    exclusions: {
      historical_import: fixture.expected_metrics.historical_exclusions,
      unclassified: fixture.expected_metrics.unclassified_exclusions,
    },
  });
  assert.equal(metrics.kpis.tasks_completed_without_intervention.numerator, fixture.expected_metrics.native_kpi_numerator);
  assert.equal(metrics.kpis.tasks_completed_without_intervention.denominator, fixture.expected_metrics.native_kpi_denominator);
  assert.equal(metrics.interventions.total, fixture.expected_metrics.intervention_total);
  assert.equal(metrics.exception_reasons[0].reason, fixture.expected_metrics.exception_reason);
  assert.equal(metrics.drill_down.length, fixture.expected_metrics.measured_jobs);
  assert.equal(metrics.drill_down.some((record) => record.job_id === "historical-import"), false);
  assert.equal(overview.items.find((item) => item.id === "item-manual-rdc").jobs[0].execution_outcome.classification,
    "exception_success");
});
