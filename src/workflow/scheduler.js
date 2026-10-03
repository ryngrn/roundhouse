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
