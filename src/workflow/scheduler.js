const emptyScheduler = (capacity) => ({
  version: 1,
  capacity,
  sequence: 0,
  projects: {},
});

/**
 * Return the durable weighted-allocation record, upgrading the implicit legacy
 * `project.turns` counters without changing their scheduling position.
 */
export function schedulerState(data, capacity = 1) {
  data.system_metadata ??= {};
  const scheduler = data.system_metadata.execution_scheduler ?? emptyScheduler(capacity);
  scheduler.version = 1;
  scheduler.capacity = capacity;
  scheduler.sequence = Number.isSafeInteger(scheduler.sequence) && scheduler.sequence >= 0 ? scheduler.sequence : 0;
  scheduler.projects ??= {};
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

/**
 * A project queue is strictly ordered by its durable position. Only its first
 * unfinished slice may be considered for dispatch; priority is an intake
 * concern and must not let later work overtake an existing project slice.
 */
export function projectQueueHead(data, projectId) {
  return Object.values(data.jobs ?? {})
    .filter((job) => job.project_id === projectId && job.state !== "Shipped")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id))[0] ?? null;
}

export function eligibleProjectHead(data, projectId) {
  const head = projectQueueHead(data, projectId);
  if (!head || head.state !== "Ready") return null;
  return (head.dependencies ?? []).every((id) => data.jobs[id]?.state === "Shipped") ? head : null;
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

export function projectExecutionEligible(project, execution, capabilities = execution.capabilities) {
  if (project.max_concurrent_runs > execution.capacity) return false;
  if ((project.required_capabilities ?? []).some((capability) => !capabilities.includes(capability))) return false;
  return Object.entries(project.resource_requirements ?? {}).every(([resource, amount]) => amount <= (execution.resource_limits[resource] ?? 0));
}

/**
 * The reservation is persisted on the job lease. Locks are deliberately stable
 * strings so workers with different configuration object identities still agree
 * about repository and delivery conflicts.
 */
export function executionReservation(project) {
  const repository = project.repository ?? `project:${project.id}`;
  const locks = [`repository:${repository}`];
  if (project.policy?.shipping !== "commit_only") locks.push(`delivery:${repository}:${project.remote ?? "origin"}`);
  if (project.policy?.shipping === "deploy") {
    locks.push(`deployment:${project.deployment?.kind ?? "unknown"}:${project.deployment?.environment ?? "production"}`);
  }
  return {
    project_id: project.id,
    project_limit: project.max_concurrent_runs ?? 1,
    capacity_units: 1,
    required_capabilities: [...(project.required_capabilities ?? [])],
    resources: { ...(project.resource_requirements ?? {}) },
    locks,
  };
}

export function reservationFits(active, candidate, execution, capabilities = execution.capabilities) {
  if ((candidate.required_capabilities ?? []).some((capability) => !capabilities.includes(capability))) return false;
  const capacityUsed = active.reduce((sum, reservation) => sum + (reservation.capacity_units ?? 1), 0);
  if (capacityUsed + (candidate.capacity_units ?? 1) > execution.capacity) return false;
  if (active.filter((reservation) => reservation.project_id === candidate.project_id).length >= (candidate.project_limit ?? 1)) return false;
  const activeLocks = new Set(active.flatMap((reservation) => reservation.locks ?? []));
  if ((candidate.locks ?? []).some((lock) => activeLocks.has(lock))) return false;
  return Object.entries(candidate.resources ?? {}).every(([resource, amount]) => {
    const used = active.reduce((sum, reservation) => sum + (reservation.resources?.[resource] ?? 0), 0);
    return used + amount <= (execution.resource_limits[resource] ?? 0);
  });
}
