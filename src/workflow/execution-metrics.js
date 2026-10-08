import { executionOutcomeClassifications, executionOutcomeMetricStatus, validateExecutionOutcome } from "./execution-outcome.js";

const completedClassifications = new Set(["native_success", "recovered_success", "exception_success"]);

const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const percentage = (numerator, denominator) => denominator ? (numerator / denominator) * 100 : null;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function classificationCounts(records) {
  const counts = Object.fromEntries(executionOutcomeClassifications.map((classification) => [classification, 0]));
  for (const record of records) counts[record.outcome.classification] += 1;
  return counts;
}

function executorComponent(record) {
  return record.outcome.execution_path.find((entry) =>
    /_(codex|claude|command)$/.test(entry.kind)) ?? record.outcome.execution_path[0];
}

function runtimeComponent(record) {
  return record.outcome.execution_path.find((entry) => entry.runtime || entry.machine)
    ?? record.outcome.execution_path[0];
}

function runtimeDimension(record) {
  const component = runtimeComponent(record);
  return component.runtime ?? (component.kind.startsWith("herdr_") ? "herdr"
    : component.kind.startsWith("local_") ? "local" : "out_of_band");
}

function machineRuntimeDimension(record) {
  const component = runtimeComponent(record);
  const runtime = component.runtime ?? (component.kind.startsWith("herdr_") ? "herdr"
    : component.kind.startsWith("local_") ? "local" : "out_of_band");
  return component.machine ? `${component.machine} / ${runtime}` : runtime;
}

function jobTypeDimension(record) {
  return record.job.work?.job_type ?? record.job.work?.action_class ?? record.job.agent_role ?? "general";
}

function dimension(records, selector) {
  const groups = new Map();
  for (const record of records) {
    const value = selector(record) || "unknown";
    const group = groups.get(value) ?? [];
    group.push(record);
    groups.set(value, group);
  }
  return [...groups.entries()].map(([value, entries]) => {
    const completed = entries.filter((entry) => completedClassifications.has(entry.outcome.classification));
    const exceptionCount = completed.filter((entry) => entry.outcome.classification === "exception_success").length;
    return {
      value,
      measured_jobs: entries.length,
      completed_jobs: completed.length,
      exception_count: exceptionCount,
      exception_rate: ratio(exceptionCount, completed.length),
      classification_counts: classificationCounts(entries),
    };
  }).sort((left, right) => right.exception_count - left.exception_count
    || right.completed_jobs - left.completed_jobs || left.value.localeCompare(right.value));
}

function trend(records, periodLength) {
  const periods = new Map();
  for (const record of records) {
    const period = record.outcome.recorded_at.slice(0, periodLength);
    const entries = periods.get(period) ?? [];
    entries.push(record);
    periods.set(period, entries);
  }
  return [...periods.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([period, entries]) => {
    const completed = entries.filter((entry) => completedClassifications.has(entry.outcome.classification));
    const counts = classificationCounts(entries);
    return {
      period,
      measured_jobs: entries.length,
      completed_jobs: completed.length,
      classification_counts: counts,
      native_success_rate: ratio(counts.native_success, completed.length),
      exception_rate: ratio(counts.exception_success, completed.length),
      average_human_interventions: completed.length
        ? completed.reduce((sum, entry) => sum + entry.outcome.human_intervention_count, 0) / completed.length : null,
    };
  });
}

/**
 * Build the authoritative execution-path KPI read model. Only explicit, valid,
 * non-historical outcome records enter a denominator. In particular, Shipped
 * state is never treated as native-path evidence.
 */
export function executionOutcomeMetrics(data, { jobIds } = {}) {
  const selected = jobIds ? new Set(jobIds) : null;
  const records = [];
  const exclusions = { historical_import: 0, unclassified: 0 };
  for (const job of Object.values(data.jobs ?? {})) {
    if (selected && !selected.has(job.id)) continue;
    const status = executionOutcomeMetricStatus(job);
    if (!status.eligible) {
      exclusions[status.reason] += 1;
      continue;
    }
    records.push({ job, outcome: validateExecutionOutcome(job.execution_outcome, { job }) });
  }

  const counts = classificationCounts(records);
  const completed = records.filter((record) => completedClassifications.has(record.outcome.classification));
  const nonNativeCompleted = counts.recovered_success + counts.exception_success;
  const interventions = completed.map((record) => record.outcome.human_intervention_count);
  const minutes = completed.map((record) => record.outcome.human_minutes).filter(Number.isFinite);
  const exceptions = records.filter((record) => record.outcome.classification === "exception_success");
  const reasonCounts = new Map();
  for (const record of exceptions) reasonCounts.set(record.outcome.reason.code,
    (reasonCounts.get(record.outcome.reason.code) ?? 0) + 1);

  const tasksCompletedWithoutIntervention = {
    numerator: counts.native_success,
    denominator: completed.length,
    rate: ratio(counts.native_success, completed.length),
    percentage: percentage(counts.native_success, completed.length),
  };
  return {
    schema_version: 1,
    population: {
      total_jobs: selected ? [...selected].filter((id) => data.jobs?.[id]).length : Object.keys(data.jobs ?? {}).length,
      measured_jobs: records.length,
      completed_jobs: completed.length,
      excluded_jobs: exclusions.historical_import + exclusions.unclassified,
      exclusions,
    },
    classification_counts: counts,
    kpis: {
      tasks_completed_without_intervention: tasksCompletedWithoutIntervention,
      native_path_success_rate: tasksCompletedWithoutIntervention,
      recovered_vs_bypassed: {
        denominator: nonNativeCompleted,
        recovered_count: counts.recovered_success,
        bypassed_count: counts.exception_success,
        recovered_share: ratio(counts.recovered_success, nonNativeCompleted),
        bypassed_share: ratio(counts.exception_success, nonNativeCompleted),
        recovered_share_of_completed: ratio(counts.recovered_success, completed.length),
        bypassed_share_of_completed: ratio(counts.exception_success, completed.length),
      },
    },
    exception_reasons: [...reasonCounts.entries()].map(([reason, count]) => ({
      reason,
      count,
      share: ratio(count, exceptions.length),
    })).sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    exception_expectation: {
      expected: exceptions.filter((record) => record.outcome.exception_expected).length,
      unexpected: exceptions.filter((record) => !record.outcome.exception_expected).length,
    },
    dimensions: {
      project: dimension(records, (record) => record.job.project_id ?? "unassigned"),
      executor: dimension(records, (record) => executorComponent(record).kind),
      provider: dimension(records, (record) => executorComponent(record).provider ?? "unspecified"),
      executor_provider: dimension(records, (record) => {
        const component = executorComponent(record);
        return `${component.kind} / ${component.provider ?? "unspecified"}`;
      }),
      machine: dimension(records, (record) => runtimeComponent(record).machine ?? "unspecified"),
      runtime: dimension(records, runtimeDimension),
      machine_runtime: dimension(records, machineRuntimeDimension),
      job_type: dimension(records, jobTypeDimension),
    },
    interventions: {
      completed_jobs: completed.length,
      total: interventions.reduce((sum, value) => sum + value, 0),
      average_per_completed_job: completed.length ? interventions.reduce((sum, value) => sum + value, 0) / completed.length : null,
      median_per_completed_job: median(interventions),
      human_minutes: {
        reported_jobs: minutes.length,
        total: minutes.reduce((sum, value) => sum + value, 0),
        average_per_reported_job: minutes.length ? minutes.reduce((sum, value) => sum + value, 0) / minutes.length : null,
        median_per_reported_job: median(minutes),
      },
    },
    trends: { daily: trend(records, 10), monthly: trend(records, 7) },
    drill_down: records.map(({ job, outcome }) => ({
      job_id: job.id,
      item_id: job.parent_id,
      project_id: job.project_id ?? null,
      job_type: jobTypeDimension({ job, outcome }),
      classification: outcome.classification,
      reason: outcome.reason,
      exception_expected: outcome.exception_expected,
      human_intervention_count: outcome.human_intervention_count,
      human_minutes: outcome.human_minutes,
      recorded_at: outcome.recorded_at,
      execution_path: outcome.execution_path,
      evidence_links: outcome.evidence_links,
    })),
  };
}
