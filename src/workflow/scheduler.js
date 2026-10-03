import { requiredExecutionCapabilities, selectExecutionProvider } from "./execution-adapters.js";

const emptyScheduler = (capacity) => ({
  version: 2,
  capacity,
  sequence: 0,
  decision_sequence: 0,
  projects: {},
  decisions: [],
  latest: {},
});

/**
 * Return the durable weighted-allocation record, upgrading the implicit legacy
 * `project.turns` counters without changing their scheduling position.
 */
export function schedulerState(data, capacity = 1) {
  data.system_metadata ??= {};
  const scheduler = data.system_metadata.execution_scheduler ?? emptyScheduler(capacity);
  scheduler.version = 2;
  scheduler.capacity = capacity;
  scheduler.sequence = Number.isSafeInteger(scheduler.sequence) && scheduler.sequence >= 0 ? scheduler.sequence : 0;
  scheduler.decision_sequence = Number.isSafeInteger(scheduler.decision_sequence) && scheduler.decision_sequence >= 0 ? scheduler.decision_sequence : 0;
  scheduler.projects ??= {};
  scheduler.decisions ??= [];
  scheduler.latest ??= {};
  for (const [projectId, runtime] of Object.entries(data.projects ?? {})) {
    scheduler.projects[projectId] ??= {
      allocations: Number.isSafeInteger(runtime.turns) && runtime.turns >= 0 ? runtime.turns : 0,
      last_selected_sequence: null,
      last_selected_at: null,
    };
  }
  data.system_metadata.execution_scheduler = scheduler;
  return scheduler;
}

export function weightedAllocation(scheduler, project) {
  return (scheduler.projects?.[project.id]?.allocations ?? 0) / project.weight;
}

/** Return the earliest unfinished slice for status and hold explanations. */
export function projectQueueHead(data, projectId) {
  return Object.values(data.jobs ?? {})
    .filter((job) => job.project_id === projectId && job.state !== "Shipped")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id))[0] ?? null;
}

export function eligibleProjectHead(data, projectId) {
  return Object.values(data.jobs ?? {})
    .filter((job) => job.project_id === projectId && job.state === "Ready"
      && (job.dependencies ?? []).every((id) => data.jobs[id]?.state === "Shipped"))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id))[0] ?? null;
}

export function recordAllocation(data, project, capacity = 1, at = new Date().toISOString()) {
  const scheduler = schedulerState(data, capacity);
  scheduler.sequence += 1;
  const allocation = scheduler.projects[project.id] ?? { allocations: 0, last_selected_sequence: null, last_selected_at: null };
  allocation.allocations += 1;
  allocation.last_selected_sequence = scheduler.sequence;
  allocation.last_selected_at = at;
  scheduler.projects[project.id] = allocation;

  // Keep the old projection readable by installations and status clients that
  // predate the explicit scheduler contract.
  data.projects[project.id] = { ...data.projects[project.id], turns: allocation.allocations };
  return allocation;
}

export function executionEligibility(project, execution, capabilities = execution.capabilities, job = null) {
  const required = requiredExecutionCapabilities(project, job);
  const missing = required.filter((capability) => !capabilities.includes(capability));
  const reasons = [];
  if (missing.length) reasons.push({ code: "capability_mismatch", message: `Missing capabilities: ${missing.join(", ")}.`, missing });
  if (!missing.length && execution.providers && !selectExecutionProvider(execution.providers, required)) {
    reasons.push({ code: "provider_unavailable", message: `No execution provider supports the required capability combination: ${required.length ? required.join(", ") : "(none)"}.`, required });
  }
  if ((job?.work?.repository_required ?? project.repository_required ?? Boolean(project.repository)) && !project.repository) {
    reasons.push({ code: "repository_unavailable", message: "This slice requires a repository, but the project has none configured." });
  }
  if (project.max_concurrent_runs > execution.capacity) reasons.push({ code: "configured_project_limit", message: "Project concurrency exceeds global execution capacity." });
  for (const [resource, amount] of Object.entries(project.resource_requirements ?? {})) {
    if (amount > (execution.resource_limits[resource] ?? 0)) reasons.push({ code: "resource_unavailable", message: `Required resource ${resource} is unavailable.` });
  }
  return { eligible: reasons.length === 0, reasons };
}

export function projectExecutionEligible(project, execution, capabilities = execution.capabilities, job = null) {
  return executionEligibility(project, execution, capabilities, job).eligible;
}

/**
 * The reservation is persisted on the job lease. Locks are deliberately stable
 * strings so workers with different configuration object identities still agree
 * about repository and delivery conflicts.
 */
export function executionReservation(project, job = null) {
  const repositoryRequired = job?.work?.repository_required ?? project.repository_required ?? Boolean(project.repository);
  const repository = project.repository ?? null;
  const locks = repository ? [`repository:${repository}`] : [];
  if (repository && project.policy?.shipping !== "commit_only") locks.push(`delivery:${repository}:${project.remote ?? "origin"}`);
  if (project.policy?.shipping === "deploy") {
    locks.push(`deployment:${project.deployment?.kind ?? "unknown"}:${project.deployment?.environment ?? "production"}`);
  }
  return {
    project_id: project.id,
    project_limit: project.max_concurrent_runs ?? 1,
    capacity_units: 1,
    required_capabilities: requiredExecutionCapabilities(project, job),
    repository: { required: repositoryRequired, configured: Boolean(repository), value: repository },
    resources: { ...(project.resource_requirements ?? {}) },
    locks,
  };
}

export function reservationFits(active, candidate, execution, capabilities = execution.capabilities) {
  return reservationAssessment(active, candidate, execution, capabilities).fits;
}

export function reservationAssessment(active, candidate, execution, capabilities = execution.capabilities) {
  const missingCapabilities = (candidate.required_capabilities ?? []).filter((capability) => !capabilities.includes(capability));
  const capacityUsed = active.reduce((sum, reservation) => sum + (reservation.capacity_units ?? 1), 0);
  const projectUsed = active.filter((reservation) => reservation.project_id === candidate.project_id).length;
  const activeLocks = new Set(active.flatMap((reservation) => reservation.locks ?? []));
  const lockConflicts = (candidate.locks ?? []).filter((lock) => activeLocks.has(lock));
  const resources = Object.entries(candidate.resources ?? {}).map(([resource, amount]) => {
    const used = active.reduce((sum, reservation) => sum + (reservation.resources?.[resource] ?? 0), 0);
    const limit = execution.resource_limits[resource] ?? 0;
    return { resource, requested: amount, used, limit, fits: used + amount <= limit };
  });
  const constraints = {
    capability: { required: [...(candidate.required_capabilities ?? [])], available: [...capabilities], missing: missingCapabilities, fits: !missingCapabilities.length },
    provider: (() => {
      if (!execution.providers || missingCapabilities.length) return { selected: null, fits: !execution.providers || Boolean(missingCapabilities.length) };
      const selected = selectExecutionProvider(execution.providers, candidate.required_capabilities ?? []);
      return { selected: selected?.id ?? null, fits: Boolean(selected) };
    })(),
    capacity: { requested: candidate.capacity_units ?? 1, used: capacityUsed, limit: execution.capacity, fits: capacityUsed + (candidate.capacity_units ?? 1) <= execution.capacity },
    project: { project_id: candidate.project_id, active: projectUsed, limit: candidate.project_limit ?? 1, fits: projectUsed < (candidate.project_limit ?? 1) },
    resources,
    locks: { requested: [...(candidate.locks ?? [])], conflicts: lockConflicts, fits: !lockConflicts.length },
    repository: { ...(candidate.repository ?? { required: true, configured: true, value: null }),
      fits: !(candidate.repository?.required && !candidate.repository?.configured) },
  };
  return { fits: constraints.capability.fits && constraints.provider.fits && constraints.capacity.fits && constraints.project.fits
    && constraints.resources.every((resource) => resource.fits) && constraints.locks.fits && constraints.repository.fits, constraints };
}

function deferralReason(checks, reservation) {
  if (!reservation.constraints.capability.fits) return { code: "capability_mismatch", message: `Missing capabilities: ${reservation.constraints.capability.missing.join(", ")}.` };
  if (!reservation.constraints.provider.fits) return { code: "provider_unavailable", message: `No execution provider supports the required capability combination: ${reservation.constraints.capability.required.length ? reservation.constraints.capability.required.join(", ") : "(none)"}.` };
  if (!reservation.constraints.repository.fits) return { code: "repository_unavailable", message: "This slice requires a repository, but the project has none configured." };
  const failed = Object.entries(checks).find(([, value]) => !value.passed);
  if (failed) return { code: failed[0], message: failed[1].reason };
  if (!reservation.constraints.capacity.fits) return { code: "capacity_exhausted", message: `Execution capacity ${reservation.constraints.capacity.used}/${reservation.constraints.capacity.limit} is in use.` };
  if (!reservation.constraints.project.fits) return { code: "project_limit", message: `Project concurrency ${reservation.constraints.project.active}/${reservation.constraints.project.limit} is in use.` };
  const resource = reservation.constraints.resources.find((entry) => !entry.fits);
  if (resource) return { code: "resource_limit", message: `${resource.resource} capacity would exceed ${resource.used}/${resource.limit}.` };
  if (!reservation.constraints.locks.fits) return { code: "lock_conflict", message: `Conflicting locks: ${reservation.constraints.locks.conflicts.join(", ")}.` };
  return { code: "fairness_order", message: "Another eligible slice ranked first by durable weighted allocation." };
}

/**
 * Explain one scheduling round before any work is started. The returned records
 * contain only durable domain facts, so the same explanation can be shown after
 * a worker restart without relying on process logs.
 */
export function dispatchConsiderations(data, projects, execution, {
  projectId, stopped = new Set(), activeReservations = [], canDispatch = () => true,
} = {}) {
  const scheduler = schedulerState(data, execution.capacity);
  return projects
    .filter((project) => !projectId || project.id === projectId)
    .map((project) => {
      const queue = Object.values(data.jobs ?? {})
        .filter((job) => job.project_id === project.id && job.state !== "Shipped")
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
      const job = eligibleProjectHead(data, project.id) ?? queue[0];
      if (!job) return null;
      const queuePosition = queue.findIndex((candidate) => candidate.id === job.id) + 1;
      // An owned or active queue head is already consuming its allocation; it
      // is not a fresh dispatch candidate and must not overwrite that allocation
      // with a later "deferred" explanation while it runs.
      if (job.owning_node_id || ["Executing", "Verification", "Rework"].includes(job.state)) return null;
      const runtime = data.projects?.[project.id] ?? {};
      const dependencies = (job.dependencies ?? []).map((id) => ({ id, state: data.jobs[id]?.state ?? "Missing" }));
      const running = Object.values(data.jobs ?? {}).filter((candidate) => candidate.project_id === project.id
        && ["Executing", "Verification", "Rework"].includes(candidate.state)).length;
      const projectGateReason = runtime.blocked ? "Project is blocked." : runtime.stop ? "Project is stopped."
        : runtime.review_required ? "Project awaits post-shipping review." : "Project gates are open.";
      const waitingDependencies = dependencies.filter((dependency) => dependency.state !== "Shipped");
      const shippingSupported = canDispatch(project);
      const checks = {
        project_active: { passed: project.status === "active", reason: project.status === "active" ? "Project is active." : `Project status is ${project.status}.` },
        continuation: { passed: !stopped.has(project.id), reason: stopped.has(project.id)
          ? "This worker invocation already allocated the project's stop-after-job slice." : "Project continuation policy permits an allocation." },
        project_gate: { passed: !runtime.blocked && !runtime.stop && !runtime.review_required,
          reason: projectGateReason },
        shipping: { passed: shippingSupported, reason: shippingSupported
          ? "The delivery provider supports this project."
          : project.repository ? "The configured delivery provider cannot dispatch this project."
            : "The installed Git delivery provider requires a configured repository; no repository-independent delivery provider is installed." },
        configured_project_limit: { passed: project.max_concurrent_runs <= execution.capacity,
          reason: project.max_concurrent_runs <= execution.capacity
            ? `Configured project concurrency ${project.max_concurrent_runs} is within global capacity ${execution.capacity}.`
            : `Project concurrency ${project.max_concurrent_runs} exceeds global capacity ${execution.capacity}.` },
        project_concurrency: { passed: running < project.max_concurrent_runs,
          reason: running < project.max_concurrent_runs ? `Project has ${running}/${project.max_concurrent_runs} active runs; a slot is available.`
            : `Project concurrency ${running}/${project.max_concurrent_runs} is in use.` },
        slice_ready: { passed: job.state === "Ready", reason: job.state === "Ready" ? "Queue head is Ready." : `Queue head is ${job.state}, not Ready.` },
        dependencies: { passed: dependencies.every((dependency) => dependency.state === "Shipped"),
          reason: waitingDependencies.length ? `Queue head is waiting for: ${waitingDependencies.map((dependency) => `${dependency.id} (${dependency.state})`).join(", ")}.`
            : dependencies.length ? "All queue-head dependencies are shipped." : "Queue head has no dependencies." },
      };
      const reservation = reservationAssessment(activeReservations, executionReservation(project, job), execution);
      const eligible = Object.values(checks).every((check) => check.passed) && reservation.fits;
      const fairness = {
        weight: project.weight,
        allocations_before: scheduler.projects[project.id]?.allocations ?? 0,
        weighted_allocation: weightedAllocation(scheduler, project),
      };
      return {
        project, job, eligible, checks, reservation, fairness,
        queue: { position: queuePosition, length: queue.length, slice_position: job.position ?? 0 },
        reason: eligible ? null : deferralReason(checks, reservation),
      };
    })
    .filter(Boolean);
}

export function recordDispatchRound(data, considerations, selectedJobId, capacity = 1, at = new Date().toISOString(), fallbackReason = null) {
  const scheduler = schedulerState(data, capacity);
  const ranked = considerations.filter((entry) => entry.eligible)
    .sort((a, b) => a.fairness.weighted_allocation - b.fairness.weighted_allocation || a.project.id.localeCompare(b.project.id));
  const rank = new Map(ranked.map((entry, index) => [entry.job.id, index + 1]));
  const records = considerations.map((entry) => {
    scheduler.decision_sequence += 1;
    const allocated = entry.job.id === selectedJobId;
    const reason = allocated
      ? { code: "allocated", message: "Selected by durable weighted allocation and all capacity, capability, resource, and lock constraints fit." }
      : entry.reason ?? (!entry.reservation.fits ? deferralReason(entry.checks, entry.reservation) : null)
        ?? fallbackReason ?? { code: "fairness_order", message: "Another eligible slice ranked first by durable weighted allocation." };
    const record = {
      sequence: scheduler.decision_sequence,
      at,
      project_id: entry.project.id,
      job_id: entry.job.id,
      slice_title: entry.job.work?.title ?? null,
      eligible: entry.eligible,
      result: allocated ? "allocated" : "deferred",
      reason,
      queue: entry.queue,
      fairness: { ...entry.fairness, rank: rank.get(entry.job.id) ?? null },
      constraints: entry.reservation.constraints,
      checks: entry.checks,
    };
    scheduler.decisions.push(record);
    scheduler.latest[entry.project.id] = record;
    return record;
  });
  return records;
}
