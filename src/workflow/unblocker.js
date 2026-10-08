/**
 * Unblocker: a low-cost, policy-constrained recovery worker.
 *
 * It never runs an executor, retries blocked work, supplies approval, alters
 * dependencies, or attests unverified remote results. Only an independently
 * evidenced, isolated local failure can relinquish its project-wide hold.
 * The job itself and all dependent jobs retain their existing states.
 */
import path from "node:path";
import { createHash } from "node:crypto";

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

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function evidenceFingerprint(root) {
  const input = root.parent?.input ?? root.entity.input ?? {};
  const history = (root.entity.history ?? []).filter((entry) => !String(entry.reason ?? "").startsWith("Unblocker retained this work:"));
  return hash({ state: root.entity.state, input, history, attempts: root.entity.attempts ?? [],
    dependencies: root.entity.dependencies ?? [], questions: root.entity.questions ?? [], response: root.entity.issue_resolution?.response ?? null });
}

function graphImpact(data, root) {
  if (root.kind !== "job") return { direct_dependents: [], descendants: [], ready_descendants: [], node_ids: [root.entity.id], fingerprint: hash([]) };
  const reverse = new Map();
  for (const job of Object.values(data.jobs ?? {})) for (const dependency of job.dependencies ?? []) {
    const values = reverse.get(dependency) ?? [];
    values.push(job.id); reverse.set(dependency, values);
  }
  const direct = [...(reverse.get(root.entity.id) ?? [])].sort();
  const seen = new Set();
  const queue = [...direct];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(reverse.get(id) ?? []));
  }
  const descendants = [...seen].sort();
  const nodeIds = [root.entity.id, ...descendants];
  const graph = nodeIds.map((id) => { const job = data.jobs?.[id]; return job ? { id, revision: job.revision, state: job.state, dependencies: job.dependencies ?? [] } : { id, missing: true }; });
  return { direct_dependents: direct, descendants, ready_descendants: descendants.filter((id) => data.jobs?.[id]?.state === "Ready"), node_ids: nodeIds, fingerprint: hash(graph) };
}

function projectPolicyFingerprint(config, projectId) {
  const project = config.projects.find((entry) => entry.id === projectId);
  return hash(project ? { id: project.id, status: project.status, runtime: project.runtime, executor: project.executor, policy: project.policy, verification: project.verification } : null);
}

function rankCandidate(data, root) {
  const impact = graphImpact(data, root);
  const age = Math.min(365, Math.max(0, (Date.now() - Date.parse(root.entity.updated_at ?? root.entity.created_at ?? Date.now())) / 86_400_000));
  const evidence = root.parent?.input ?? root.entity.input ?? {};
  const score = impact.ready_descendants.length * 1_000 + impact.descendants.length * 100 + age +
    (root.entity.state === "Blocked" ? 25 : 0) + (root.entity.issue_resolution?.response ? 200 : 0) + (evidence.conversation ? 15 : 0);
  return { score, impact };
}

function cleanupCandidates(data) {
  const jobs = Object.values(data.jobs ?? {}).filter(cleanupEligible).map((entity) => ({
    kind: "job", entity, parent: data.items?.[entity.parent_id] ?? null,
  }));
  const items = Object.values(data.items ?? {}).filter(cleanupEligible).map((entity) => ({ kind: "item", entity, parent: entity }));
  return [...jobs, ...items]
    .filter((root) => root.entity.issue_resolution?.status !== "waiting")
    .filter((root) => root.entity.issue_resolution?.status !== "kept" || root.entity.issue_resolution.evidence_fingerprint !== evidenceFingerprint(root))
    .map((root) => ({ ...root, priority: rankCandidate(data, root) }))
    .sort((a, b) => b.priority.score - a.priority.score || a.entity.id.localeCompare(b.entity.id));
}

function cleanupPacket(data, root, config) {
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
    impact: root.priority.impact,
    guard: { revision: root.entity.revision, evidence_fingerprint: evidenceFingerprint(root),
      graph_fingerprint: root.priority.impact.fingerprint,
      policy_fingerprint: projectPolicyFingerprint(config, root.entity.project_id ?? root.parent?.project_id ?? null) },
  };
}

function currentRoot(data, root) {
  const entity = root.kind === "job" ? data.jobs?.[root.entity.id] : data.items?.[root.entity.id];
  return entity ? { kind: root.kind, entity, parent: root.kind === "job" ? data.items?.[entity.parent_id] ?? null : entity } : null;
}

function assertCleanupGuard(data, root, packet, config) {
  const current = currentRoot(data, root);
  if (!current || !cleanupEligible(current.entity) || current.entity.revision !== packet.guard.revision) throw new Error("Cleanup candidate changed; reevaluation is required.");
  if (evidenceFingerprint(current) !== packet.guard.evidence_fingerprint) throw new Error("Cleanup evidence changed; reevaluation is required.");
  if (graphImpact(data, current).fingerprint !== packet.guard.graph_fingerprint) throw new Error("Cleanup dependency graph changed; reevaluation is required.");
  const projectId = current.entity.project_id ?? current.parent?.project_id ?? null;
  if (projectPolicyFingerprint(config, projectId) !== packet.guard.policy_fingerprint) throw new Error("Cleanup project policy changed; reevaluation is required.");
  return current;
}

function calibratedConfidence(decision, brief, packet, data) {
  const evidenceScore = Math.min(0.5, brief.evidence.length / 6) + (packet.candidate.original_request ? 0.2 : 0) +
    (packet.candidate.conversation || packet.candidate.conversation_link ? 0.2 : 0) + (brief.unresolved_assumptions.length ? 0 : 0.1);
  const direct = packet.impact.direct_dependents.length;
  const represented = new Set(decision.dependent_actions.map((entry) => entry.id));
  const graphScore = direct ? packet.impact.direct_dependents.filter((id) => represented.has(id)).length / direct : 1;
  const prior = data.system_metadata?.cleanup_metrics;
  const historical = prior?.operator_answers ? Math.max(0.5, Math.min(0.95, prior.operator_accepted / prior.operator_answers)) : 0.7;
  const riskPenalty = decision.action === "delete" ? 0.05 : decision.action === "repurpose" ? 0.03 : 0;
  return Math.max(0, Math.min(1, decision.confidence * 0.65 + evidenceScore * 0.2 + graphScore * 0.1 + historical * 0.05 - riskPenalty));
}

function metrics(data) {
  data.system_metadata ??= {};
  data.system_metadata.cleanup_metrics = { decisions: 0, deleted: 0, repurposed: 0, asked: 0, kept: 0,
    work_released: 0, operator_answers: 0, operator_accepted: 0, invalidated: 0, deleted_recreated: 0,
    repurposed_shipped: 0, decision_latency_ms: 0, decision_log: [], ...(data.system_metadata.cleanup_metrics ?? {}) };
  return data.system_metadata.cleanup_metrics;
}

function recordMetric(data, { action, root, packet, decision, brief, at }) {
  const value = metrics(data);
  const counter = { delete: "deleted", repurpose: "repurposed", ask: "asked", keep: "kept" }[action];
  value.decisions += 1; value[counter] = (value[counter] ?? 0) + 1;
  value.work_released += action === "delete" || action === "repurpose" ? packet.impact.ready_descendants.length : 0;
  value.decision_latency_ms += decision.latency_ms ?? 0;
  value.decision_log.push({ id: root.entity.id, action, at, model_confidence: decision.confidence,
    calibrated_confidence: decision.calibrated_confidence, blocker_category: brief.blocker_category,
    downstream_jobs: packet.impact.descendants.length, ready_descendants: packet.impact.ready_descendants.length,
    latency_ms: decision.latency_ms ?? null });
  if (value.decision_log.length > 1_000) value.decision_log.splice(0, value.decision_log.length - 1_000);
}

function fallbackOptions(packet) {
  const affected = packet.impact.descendants.length;
  return [
    { id: "delete-and-repurpose", label: "Remove the blocker and keep useful downstream work",
      description: `Delete this record and preserve relevant scope in ${affected} downstream job${affected === 1 ? "" : "s"}.`,
      effects: ["The blocked record is permanently deleted", `${affected} downstream job${affected === 1 ? "" : "s"} keep their identities`] },
    { id: "preserve-and-narrow", label: "Preserve it with a smaller plan",
      description: "Keep this record and narrow its scope before any queue movement.", effects: ["No work is deleted", "The blocker remains held"] },
  ];
}

function startedWorkOptions(packet) {
  return [
    { id: "preserve-for-reconciliation", label: "Preserve it for reconciliation",
      description: "Keep the existing attempt and identity so its external outcome can be inspected before any replacement work.",
      effects: ["No work is deleted", "The existing attempt remains blocked and auditable"] },
    { id: "delete-unverified-attempt", label: "Delete the unverified work",
      description: "Permanently remove the blocked record without claiming that its attempt succeeded.",
      effects: ["The blocked record is permanently deleted", `${packet.impact.descendants.length} downstream job${packet.impact.descendants.length === 1 ? "" : "s"} will be reevaluated`] },
  ];
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
      confidence: action?.confidence ?? null,
    };
    job.revision += 1;
    job.updated_at = at;
    job.history.push({ from: job.state, to: job.state, reason: `Scope repurposed after ${removedId} was deleted; identity preserved.`, at });
  }
}

function deleteCandidate(data, root, decision, brief, at) {
  const entity = root.kind === "job" ? data.jobs[root.entity.id] : data.items[root.entity.id];
  if (!entity || !cleanupEligible(entity)) throw new Error("Cleanup candidate changed before deletion.");
  if ((entity.processes ?? []).length || entity.owning_node_id || ["Executing", "Verification", "Shipped"].includes(entity.state)) throw new Error("Active or shipped work cannot be cleaned up.");
  const record = { id: entity.id, kind: root.kind, project_id: entity.project_id ?? null,
    title: entity.work?.title ?? entity.input?.text?.split("\n")[0]?.slice(0, 160) ?? entity.id,
    prior_state: entity.state, prior_revision: entity.revision, confidence: decision.confidence,
    reason: decision.reason, blocker_category: brief.blocker_category,
    desired_outcome: brief.desired_outcome, evidence: brief.evidence.map((entry) => entry.source),
    deleted_at: at, actor: "roundhouse-unblocker" };
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

function repurposeCandidate(data, root, decision, brief, at) {
  const entity = root.kind === "job" ? data.jobs[root.entity.id] : data.items[root.entity.id];
  if (!entity || !cleanupEligible(entity)) throw new Error("Cleanup candidate changed before repurposing.");
  if (root.kind === "job" && (entity.attempts?.length ?? 0) > 0) throw new Error("Started work cannot be repurposed safely; delete it or ask the operator.");
  entity.scope_revision = { at, source: "roundhouse-unblocker", active_scope: decision.active_scope,
    removed_scope: decision.removed_scope, confidence: decision.confidence, reason: decision.reason };
  entity.cleanup_intent = { ...brief, distilled_at: at, evidence_fingerprint: evidenceFingerprint(root) };
  entity.issue_resolution = null;
  if (root.kind === "job") {
    entity.work = { ...entity.work, outcome: decision.active_scope };
    entity.dependencies = entity.dependencies?.filter((id) => data.jobs?.[id]) ?? [];
    entity.state = "Ready";
    const otherBlocked = Object.values(data.jobs ?? {}).some((job) => job.id !== entity.id && job.project_id === entity.project_id && job.state === "Blocked");
    if (!otherBlocked) data.projects[entity.project_id] = { ...(data.projects[entity.project_id] ?? {}), blocked: false, active: false };
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
    if (root && this.engine?.decision?.decideCleanup && this.engine?.decision?.distillCleanupIntent) {
      const packet = cleanupPacket(beforeCleanup, root, this.config);
      const decisionStartedAt = Date.now();
      const projects = this.config.projects.map((project) => ({ id: project.id, name: project.name, purpose: project.purpose,
        success_state: project.success_state, status: project.status, runtime: project.runtime, policy: project.policy }));
      const directory = path.join(this.store.directory, "cleanup-decisions", root.entity.id, String(root.entity.revision));
      const intentBrief = await this.engine.decision.distillCleanupIntent({ ...packet, projects, directory, onStart: undefined });
      const proposed = await this.engine.decision.decideCleanup({ ...packet, intentBrief, projects,
        directory: path.join(this.store.directory, "cleanup-decisions", root.entity.id, String(root.entity.revision)),
        onStart: undefined,
      });
      const decision = { ...proposed, calibrated_confidence: calibratedConfidence(proposed, intentBrief, packet, beforeCleanup),
        latency_ms: Date.now() - decisionStartedAt };
      const dependentById = new Map(decision.dependent_actions.map((entry) => [entry.id, entry]));
      const uncertainDependent = decision.action === "delete" && packet.dependents.some((entry) => (dependentById.get(entry.id)?.confidence ?? 0) < 0.7);
      const startedRepurpose = decision.action === "repurpose" && root.kind === "job" && (root.entity.attempts?.length ?? 0) > 0;
      const effective = decision.calibrated_confidence < 0.7 || uncertainDependent || startedRepurpose
        ? { ...decision, action: "ask",
          reason: startedRepurpose ? "This job already has an execution attempt, so changing its meaning requires an operator decision."
            : uncertainDependent ? "Deleting this work would require an uncertain change to dependent work." : decision.reason,
          question: startedRepurpose ? `Should I preserve “${packet.candidate.title}” for outcome reconciliation, or delete the unverified work?`
            : decision.question || `Should I delete “${packet.candidate.title}” and repurpose the useful work behind it, or preserve it for a smaller plan?`,
          options: startedRepurpose ? startedWorkOptions(packet) : decision.options.length === 2 ? decision.options : fallbackOptions(packet) }
        : decision;
      const at = new Date().toISOString();
      const commit = (change) => {
        try { return this.store.change(change); }
        catch (error) {
          if (/changed|reevaluation|required/i.test(error.message)) this.store.change(data => { metrics(data).invalidated += 1; });
          throw error;
        }
      };
      if (effective.action === "ask") {
        cleanup = await commit(data => {
          const current = assertCleanupGuard(data, root, packet, this.config);
          const entity = current.entity;
          entity.cleanup_intent = { ...intentBrief, distilled_at: at, evidence_fingerprint: packet.guard.evidence_fingerprint };
          entity.issue_resolution = { status: "waiting", confidence: effective.calibrated_confidence, model_confidence: effective.confidence, reason: effective.reason,
            question: effective.question, options: [...effective.options, { id: "custom", label: "Take my own path", description: "Give Roundhouse a different direction.", effects: ["No action occurs until your direction is reevaluated"] }],
            impact: packet.impact, at };
          entity.revision += 1;
          entity.updated_at = at;
          entity.history.push({ from: entity.state, to: entity.state, reason: "Unblocker needs operator guidance before cleanup.", at });
          recordMetric(data, { action: "ask", root, packet, decision: effective, brief: intentBrief, at });
          return { action: "ask", id: entity.id, issue_resolution: entity.issue_resolution };
        });
      } else if (effective.action === "delete") {
        cleanup = await commit(data => {
          assertCleanupGuard(data, root, packet, this.config);
          const tombstone = deleteCandidate(data, root, effective, intentBrief, at);
          recordMetric(data, { action: "delete", root, packet, decision: effective, brief: intentBrief, at });
          return { action: "delete", tombstone };
        });
      } else if (effective.action === "repurpose") {
        cleanup = await commit(data => {
          const current = assertCleanupGuard(data, root, packet, this.config);
          const id = repurposeCandidate(data, current, effective, intentBrief, at).id;
          recordMetric(data, { action: "repurpose", root, packet, decision: effective, brief: intentBrief, at });
          return { action: "repurpose", id };
        });
      } else cleanup = await commit(data => {
        const current = assertCleanupGuard(data, root, packet, this.config);
        const entity = current.entity;
        entity.cleanup_intent = { ...intentBrief, distilled_at: at, evidence_fingerprint: packet.guard.evidence_fingerprint };
        entity.issue_resolution = { status: "kept", confidence: effective.calibrated_confidence, model_confidence: effective.confidence,
          reason: effective.reason, evidence_fingerprint: packet.guard.evidence_fingerprint,
          reconsider_when: "request, conversation, operator response, failure evidence, dependencies, or blocker state changes", at };
        entity.revision += 1;
        entity.updated_at = at;
        recordMetric(data, { action: "keep", root, packet, decision: effective, brief: intentBrief, at });
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
      cleanup_metrics: current.system_metadata?.cleanup_metrics ?? null,
      questions_created: [], questions_created_count: cleanup?.action === "ask" ? 1 : 0,
      isolated_jobs: unresolved.filter(x => x.action === "isolate_job").length,
      needs_attention: unresolved.filter(x => x.action === "human_review").length,
      findings: unresolved.slice(0, 25) };
  }
}
