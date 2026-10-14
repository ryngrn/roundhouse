/** Resolve the execution context for exactly one work slice. The returned
 * object preserves the project identity and scheduling controls while replacing
 * every repository-sensitive setting with the selected repository's policy. */
export function resolveRepositoryContext(project, work = {}) {
  const normalized = Object.hasOwn(project ?? {}, "repositories");
  const repositories = project?.repositories ?? (project?.repository
    ? [{ id: "default", checkout_path: project.repository, repository: project.repository,
      base_ref: project.base_ref, remote: project.remote, verification: project.verification,
      policy: project.policy, deployment: project.deployment }]
    : []);
  const requested = work.repository_id ?? null;
  // An explicit checkout target always acquires a repository lock, even if a
  // model incorrectly labels the slice as repository-independent.
  const required = Boolean(requested) || (work.repository_required ?? project?.repository_required ?? repositories.length > 0);
  const machineLocal = project?.runtime === "herdr" && project?.herdr?.workspace_mode === "machine_local";
  let repository = null;
  if (requested) {
    repository = repositories.find((candidate) => candidate.id === requested) ?? null;
    if (!repository) return { ok: false, required, repository_id: requested, code: "unknown_repository",
      message: `Repository target ${requested} is not configured for project ${project.id}.` };
  } else if (required && repositories.length === 1) repository = repositories[0];
  else if (required && repositories.length === 0 && !normalized) return { ok: true, required, repository_id: null, repository: null, project };
  else if (required && repositories.length === 0 && machineLocal) return { ok: true, required, repository_id: null, repository: null, project };
  else if (required && repositories.length === 0) return { ok: false, required, repository_id: null, code: "repository_setup_required",
    message: "This development slice requires a repository. Connect an existing repository or create and connect one as a separate explicit setup action; Roundhouse will not create a remote repository or request credentials." };
  else if (required && repositories.length > 1) return { ok: false, required, repository_id: null, code: "repository_ambiguous",
    message: `This development slice must select one repository_id from: ${repositories.map((candidate) => candidate.id).join(", ")}.` };

  if (!repository) return { ok: true, required: false, repository_id: null, repository: null, project };
  const resolved = {
    ...project,
    repository_id: repository.id,
    repository: repository.checkout_path ?? repository.repository,
    checkout_path: repository.checkout_path ?? repository.repository,
    base_ref: repository.base_ref ?? project.base_ref,
    remote: repository.remote ?? project.remote,
    verification: repository.verification ?? project.verification,
    policy: repository.policy ?? project.policy,
    deployment: repository.deployment ?? project.deployment,
    context_sources: repository.context_sources ?? project.context_sources,
    agent: repository.agent ? { ...project.agent, ...repository.agent } : project.agent,
    self_hosting: repository.self_hosting ?? project.self_hosting,
  };
  return { ok: true, required, repository_id: repository.id, repository, project: resolved };
}

export function repositorySelectionReason(project, work) {
  const resolution = resolveRepositoryContext(project, work);
  return resolution.ok ? null : { code: resolution.code, message: resolution.message,
    repository_id: resolution.repository_id };
}


// Older durable jobs were created before repository_id existed. Accept their
// original single-repository binding only when the exact checkout still matches;
// a newly multi-repository project never gets this implicit upgrade.
export function matchesRepositoryBinding(project, job, resolution) {
  if (!resolution?.ok || !job) return false;
  const recorded = job.repository_id ?? job.work?.repository_id ?? null;
  if (recorded === resolution.repository_id) return true;
  return recorded === null
    && resolution.repository_id === 'default'
    && (project?.repositories?.length ?? 0) === 1
    && project.repositories[0].id === 'default'
    && Boolean(job.project_context?.repository)
    && job.project_context.repository === resolution.project.repository;
}
