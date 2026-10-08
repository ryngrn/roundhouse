/**
 * Unblocker: a low-cost, policy-constrained recovery worker.
 *
 * It never runs an executor, retries blocked work, supplies approval, alters
 * dependencies, or attests unverified remote results. Only an independently
 * evidenced, isolated local failure can relinquish its project-wide hold.
 * The job itself and all dependent jobs retain their existing states.
 */
import path from "node:path";

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

const cleanupEligible = (entity) => ["Needs Clarification", "Blocked"].includes(entity?.state);

function cleanupCandidates(data) {
  const jobs = Object.values(data.jobs ?? {}).filter(cleanupEligible).map((entity) => ({
    kind: "job", entity, parent: data.items?.[entity.parent_id] ?? null,
  }));
  const items = Object.values(data.items ?? {}).filter(cleanupEligible).map((entity) => ({ kind: "item", entity, parent: entity }));
  return [...jobs, ...items].filter(({ entity }) => !["waiting", "kept"].includes(entity.issue_resolution?.status));
}

function cleanupPacket(data, root) {
  const dependents = root.kind === "job" ? Object.values(data.jobs ?? {}).filter((job) => (job.dependencies ?? []).includes(root.entity.id)) : [];
  const input = root.parent?.input ?? root.entity.input ?? {};
  return {
    candidate: {
      kind: root.kind, id: root.entity.id, revision: root.entity.revision, state: root.entity.state,
      project_id: root.entity.project_id ?? root.parent?.project_id ?? null,
      title: root.entity.work?.title ?? input.context?.title ?? input.text?.split("\n")[0]?.slice(0, 200) ?? root.entity.id,
      original_request: input.text ?? null,
      conversation: input.conversation ?? input.context?.conversation ?? null,
      conversation_link: input.metadata?.conversation_url ?? input.metadata?.conversation_id ?? null,
      scope_revision: root.entity.scope_revision ?? null,
      open_questions: (root.entity.questions ?? []).filter((question) => question.status === "open"),
      history: root.entity.history ?? [], attempts: root.entity.attempts ?? [],
      operator_response: root.entity.issue_resolution?.response ?? null,
    },
    dependents: dependents.map((job) => ({ id: job.id, state: job.state, title: job.work?.title ?? job.id,
      outcome: job.work?.outcome ?? null, dependencies: job.dependencies ?? [] })),
  };
}

function tombstones(data) {
  data.system_metadata ??= {};
  data.system_metadata.cleanup_tombstones ??= [];
  return data.system_metadata.cleanup_tombstones;
}

function applyDependentRevisions(data, removedId, actions, at) {
  const specified = new Map(actions.map((action) => [action.id, action]));
  for (const job of Object.values(data.jobs ?? {})) {
    if (!(job.dependencies ?? []).includes(removedId)) continue;
    const action = specified.get(job.id);
    job.dependencies = job.dependencies.filter((dependency) => dependency !== removedId);
    job.scope_revision = {
      at, source: "roundhouse-unblocker", active_scope: action?.active_scope || job.work?.outcome || job.work?.title || job.id,
      removed_scope: action?.removed_scope?.length ? action.removed_scope : [`Dependency on deleted work ${removedId}.`],
    };
    job.revision += 1;
    job.updated_at = at;
    job.history.push({ from: job.state, to: job.state, reason: `Scope repurposed after ${removedId} was deleted; identity preserved.`, at });
  }
}

function deleteCandidate(data, root, decision, at) {
  const entity = root.kind === "job" ? data.jobs[root.entity.id] : data.items[root.entity.id];
  if (!entity || !cleanupEligible(entity)) throw new Error("Cleanup candidate changed before deletion.");
  if ((entity.processes ?? []).length || entity.owning_node_id || ["Executing", "Verification", "Shipped"].includes(entity.state)) throw new Error("Active or shipped work cannot be cleaned up.");
  const record = { id: entity.id, kind: root.kind, project_id: entity.project_id ?? null,
    title: entity.work?.title ?? entity.input?.text?.split("\n")[0]?.slice(0, 160) ?? entity.id,
    prior_state: entity.state, prior_revision: entity.revision, confidence: decision.confidence,
    reason: decision.reason, deleted_at: at, actor: "roundhouse-unblocker" };
  tombstones(data).push(record);
  if (root.kind === "job") {
    applyDependentRevisions(data, entity.id, decision.dependent_actions, at);
    const parent = data.items?.[entity.parent_id];
    if (parent) parent.job_ids = (parent.job_ids ?? []).filter((id) => id !== entity.id);
    delete data.jobs[entity.id];
  } else {
    if ((entity.job_ids ?? []).some((id) => data.jobs?.[id])) throw new Error("An item with retained jobs cannot be deleted by cleanup.");
    delete data.items[entity.id];
  }
  for (const [id, item] of Object.entries(data.items ?? {})) {
    if (item.blocker_followup?.original_id === entity.id || item.input?.context?.blocker_entity_id === entity.id) delete data.items[id];
  }
  if (data.system_metadata.cleanup_tombstones.length > 1_000) data.system_metadata.cleanup_tombstones.splice(0, data.system_metadata.cleanup_tombstones.length - 1_000);
  return record;
}

function repurposeCandidate(data, root, decision, at) {
  const entity = root.kind === "job" ? data.jobs[root.entity.id] : data.items[root.entity.id];
  if (!entity || !cleanupEligible(entity)) throw new Error("Cleanup candidate changed before repurposing.");
  if (root.kind === "job" && (entity.attempts?.length ?? 0) > 0) throw new Error("Started work cannot be repurposed safely; delete it or ask the operator.");
  entity.scope_revision = { at, source: "roundhouse-unblocker", active_scope: decision.active_scope,
    removed_scope: decision.removed_scope, confidence: decision.confidence, reason: decision.reason };
  entity.issue_resolution = null;
  if (root.kind === "job") {
    entity.work = { ...entity.work, outcome: decision.active_scope };
    entity.dependencies = entity.dependencies?.filter((id) => data.jobs?.[id]) ?? [];
    data.projects[entity.project_id] = { ...(data.projects[entity.project_id] ?? {}), blocked: false, active: false };
    entity.state = "Ready";
  } else {
    for (const question of entity.questions ?? []) if (question.status === "open") question.status = "superseded";
    entity.state = "Decision";
    entity.awaiting_decision = true;
  }
  entity.revision += 1;
  entity.updated_at = at;
  entity.history.push({ from: root.entity.state, to: entity.state, reason: `Scope repurposed by Unblocker at ${Math.round(decision.confidence * 100)}% confidence: ${decision.reason}`, at });
  return entity;
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
    let cleanup = null;
    const beforeCleanup = await this.store.read();
    const root = cleanupCandidates(beforeCleanup)[0];
    if (root && this.engine?.decision?.decideCleanup) {
      const packet = cleanupPacket(beforeCleanup, root);
      const decision = await this.engine.decision.decideCleanup({ ...packet,
        projects: this.config.projects.map((project) => ({ id: project.id, name: project.name, purpose: project.purpose,
          success_state: project.success_state, status: project.status, runtime: project.runtime, policy: project.policy })),
        directory: path.join(this.store.directory, "cleanup-decisions", root.entity.id, String(root.entity.revision)),
        onStart: undefined,
      });
      const dependentById = new Map(decision.dependent_actions.map((entry) => [entry.id, entry]));
      const uncertainDependent = decision.action === "delete" && packet.dependents.some((entry) => (dependentById.get(entry.id)?.confidence ?? 0) < 0.7);
      const effective = decision.confidence < 0.7 || uncertainDependent
        ? { ...decision, action: "ask",
          reason: uncertainDependent ? "Deleting this work would require an uncertain change to dependent work." : decision.reason,
          question: decision.question || `Should I delete “${packet.candidate.title}” and repurpose the useful work behind it, or preserve it for a smaller plan?`,
          options: decision.options.length === 2 ? decision.options : ["Delete it and repurpose the useful dependent work", "Preserve it and propose a smaller plan"] }
        : decision;
      const at = new Date().toISOString();
      if (effective.action === "ask") {
        cleanup = await this.store.change(data => {
          const entity = root.kind === "job" ? data.jobs[root.entity.id] : data.items[root.entity.id];
          if (!entity || !cleanupEligible(entity) || entity.revision !== root.entity.revision) throw new Error("Cleanup candidate changed while asking for input.");
          entity.issue_resolution = { status: "waiting", confidence: effective.confidence, reason: effective.reason,
            question: effective.question, options: [...effective.options, "Take my own path"], at };
          entity.revision += 1;
          entity.updated_at = at;
          entity.history.push({ from: entity.state, to: entity.state, reason: "Unblocker needs operator guidance before cleanup.", at });
          return { action: "ask", id: entity.id, issue_resolution: entity.issue_resolution };
        });
      } else if (effective.action === "delete") {
        cleanup = await this.store.change(data => ({ action: "delete", tombstone: deleteCandidate(data, root, effective, at) }));
      } else if (effective.action === "repurpose") {
        cleanup = await this.store.change(data => ({ action: "repurpose", id: repurposeCandidate(data, root, effective, at).id }));
      } else cleanup = await this.store.change(data => {
        const entity = root.kind === "job" ? data.jobs[root.entity.id] : data.items[root.entity.id];
        if (entity) entity.issue_resolution = { status: "kept", confidence: effective.confidence, reason: effective.reason, at };
        return { action: "keep", id: root.entity.id, reason: effective.reason };
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
    return { role: "Unblocker", refreshed, released_projects: released, cleanup,
      questions_created: [], questions_created_count: cleanup?.action === "ask" ? 1 : 0,
      isolated_jobs: unresolved.filter(x => x.action === "isolate_job").length,
      needs_attention: unresolved.filter(x => x.action === "human_review").length,
      findings: unresolved.slice(0, 25) };
  }
}
