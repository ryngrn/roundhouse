/**
 * Unblocker: a low-cost, policy-constrained recovery worker.
 *
 * It never runs an executor, retries blocked work, supplies approval, alters
 * dependencies, or attests unverified remote results. Only an independently
 * evidenced, isolated local failure can relinquish its project-wide hold.
 * The job itself and all dependent jobs retain their existing states.
 */
const ISOLATED_VERIFICATION = /^Rework limit reached: Required verification failed\.$/;
const STALE_PROJECT_CONTEXT = /^Project policy or context changed after decision; resubmit for a new decision\.$/;
const SAFE_SHIPPING = new Set(["commit_only", "push_branch"]);

function uncertainAttempt(attempt) {
  return Boolean(attempt?.execution?.remote_execution ||
    attempt?.execution?.remote_report ||
    attempt?.shipping || attempt?.delivery ||
    attempt?.reconciliation ||
    attempt?.verification?.independently_verified === false);
}

export function diagnoseBlocker(job, project) {
  const reason = job?.history?.at(-1)?.reason ?? "";
  if (!job || job.state !== "Blocked") return { category: "not_blocked", action: "none" };
  if (!project) return { category: "unknown_project", action: "human_review" };
  if (project.runtime !== "local" || !SAFE_SHIPPING.has(project.policy?.shipping)) {
    return { category: "remote_or_external_outcome", action: "human_review" };
  }
  if (!["codex", "claude"].includes(project.executor?.kind)) {
    return { category: "external_executor", action: "human_review" };
  }
  if (job.shipping || job.reconciliation || (job.attempts ?? []).some(uncertainAttempt)) {
    return { category: "delivery_or_outcome_uncertain", action: "human_review" };
  }
  if (STALE_PROJECT_CONTEXT.test(reason) && (job.attempts?.length ?? 0) === 0) {
    // Engine.refreshJobContext enforces a full execution-authority comparison.
    return { category: "stale_context", action: "refresh_if_authority_unchanged" };
  }
  if (ISOLATED_VERIFICATION.test(reason) &&
    (job.attempts ?? []).some(a => a.verification?.passed === false &&
      a.verification.checks?.some(check => check.passed === false)) &&
    !job.attempts.some(a => a.execution?.remote_execution)) {
    return { category: "isolated_verification_failure", action: "isolate_job" };
  }
  return { category: "unverified_failure", action: "human_review" };
}

function blockedJobsFor(data, projectId) {
  return Object.values(data.jobs ?? {}).filter(job => job.project_id === projectId && job.state === "Blocked");
}

function possibleRelease(data, project) {
  const state = data.projects?.[project.id];
  if (!state?.blocked || state.stop || state.review_required) return null;
  // An explicit Review is an authority gate, not something Unblocker can clear.
  if (Object.values(data.items ?? {}).some(item => item.project_id === project.id && item.state === "Review")) return null;
  const blocked = blockedJobsFor(data, project.id);
  if (!blocked.length) return null; // A project-wide hold without cause is not safe to clear.
  const diagnoses = blocked.map(job => ({ job, ...diagnoseBlocker(job, project) }));
  // A still-blocked context-drift job has not passed authority revalidation.
  // It cannot clear a project quarantine based only on its failure message.
  if (diagnoses.some(x => x.action !== "isolate_job")) return null;
  return { jobs: diagnoses.map(x => ({ id: x.job.id, category: x.category })) };
}

export class Unblocker {
  constructor({ store, config, engine }) {
    Object.assign(this, { store, config, engine });
  }
  async run() {
    let snapshot = await this.store.read();
    let refreshed = 0;
    // Bounded to one context repair per wake. The Engine performs the actual
    // execution-authority validation and refuses started or changed work.
    const candidate = Object.values(snapshot.jobs ?? {}).find(job => {
      const project = this.config.projects.find(p => p.id === job.project_id);
      if (!project || diagnoseBlocker(job, project).action !== "refresh_if_authority_unchanged") return false;
      const projectState = snapshot.projects?.[project.id];
      if (projectState?.stop || projectState?.review_required) return false;
      if (Object.values(snapshot.items ?? {}).some(item => item.project_id === project.id && item.state === "Review")) return false;
      // refreshJobContext clears the project block as part of its existing
      // atomic transition. Never call it while any other unsafe blocker
      // would require that project-wide quarantine to remain intact.
      return blockedJobsFor(snapshot, project.id).every(other =>
        ["refresh_if_authority_unchanged", "isolate_job"].includes(diagnoseBlocker(other, project).action));
    });
    if (candidate && this.engine?.refreshJobContext) {
      try {
        await this.engine.refreshJobContext(candidate.id, { actor: "roundhouse-unblocker" });
        refreshed = 1;
      } catch {
        // Changed authority or an in-flight revision is a human decision.
        // No write, no retry, no change in current execution rights.
      }
    }
    snapshot = await this.store.read();
    const releases = this.config.projects
      .map(project => ({ project, action: possibleRelease(snapshot, project) }))
      .filter(x => x.action);
    let released = [];
    if (releases.length) {
      released = await this.store.change(data => {
        const changes = [];
        for (const { project } of releases) {
          const updated = possibleRelease(data, project); // Revalidate under the state lock.
          if (!updated) continue;
          const at = new Date().toISOString();
          data.projects[project.id] = {
            ...data.projects[project.id], blocked: false, active: false,
            unblocker: { at, action: "isolated_local_failure", affected_jobs: updated.jobs,
              explanation: "Project may dispatch independent Ready jobs; failed work and dependent jobs remain held." },
          };
          changes.push(project.id);
        }
        return changes;
      });
    }
    const current = await this.store.read();
    const unresolved = [
      ...this.config.projects.flatMap(project =>
        blockedJobsFor(current, project.id).map(job => {
          const finding = diagnoseBlocker(job, project);
          return { job_id: job.id, project_id: project.id, category: finding.category, action: finding.action };
        })),
      ...Object.values(current.items ?? {}).filter(item => item.state === "Blocked" && !(item.job_ids?.length))
        .map(item => ({ item_id: item.id, project_id: item.project_id ?? null,
          category: "unplanned_blocked_intake", action: "human_review" })),
    ];
    return { role: "Unblocker", refreshed, released_projects: released,
      isolated_jobs: unresolved.filter(x => x.action === "isolate_job").length,
      needs_attention: unresolved.filter(x => x.action === "human_review").length,
      findings: unresolved.slice(0, 25) };
  }
}
