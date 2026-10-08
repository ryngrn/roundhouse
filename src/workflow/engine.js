import path from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../storage/repository.js";
import { record } from "./state.js";
import { projectContext } from "./config.js";
import { DecisionProvider, inferRoutineAcceptanceCriteria, routeDecision } from "./decision.js";
import { createRuntime, CommandVerifier } from "./runtime.js";
import { CapabilityRuntime, executionProviderEvidence, requiredExecutionCapabilities } from "./execution-adapters.js";
import { providerCapabilityEvidence, providerIdentity } from "./provider-contract.js";
import { DeliveryRouter } from "./delivery.js";
import { composeAgentRole, inferAgentRole } from "./roles.js";
import { RoundhouseError } from "../errors.js";
import { exactReconciliationTarget, hasImportedTriageBarrier, priorityRank, selectTriageCandidates, triageBackoff, triageFingerprint } from "./triage.js";
import { dispatchConsiderations, executionEligibility, executionReservation, recordAllocation, recordDispatchRound, schedulerState } from "./scheduler.js";
import { assessJobEligibility, ensureNextOccurrence, initializeJobSchedule, nextScheduledWake, recordConditionSignal } from "./scheduling.js";
import { actionPolicy, approvalScope, assertProviderAuthorized, classifyAction } from "./actions.js";

const isMachineLocal = (project) => project.runtime === "herdr" && project.herdr?.workspace_mode === "machine_local";

function configuredDecisionProviderEvidence(configuration) {
  const selected = providerIdentity(configuration, configuration?.kind ?? "decision-provider");
  return providerCapabilityEvidence(configuration ? [configuration] : [], ["decision"], selected);
}

function recordProviderTransition(entity, previousProviderId, providerId, attempt, at) {
  if (!previousProviderId || !providerId || previousProviderId === providerId) return;
  entity.provider_transitions ??= [];
  entity.provider_transitions.push({ from: previousProviderId, to: providerId, attempt, at, reason: "Provider selected for a later attempt." });
}

function machineLocalEvidence(project, job, execution) {
  const report = execution.remote_report;
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Machine-local Herdr execution did not return structured remote evidence.");
  if (report.passed !== true || typeof report.summary !== "string" || !report.summary.trim()) throw new Error("Machine-local Herdr agent did not attest successful completion.");
  if (typeof report.commit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(report.commit)) throw new Error("Machine-local Herdr evidence requires a full lowercase Git commit SHA.");
  const expectedBranch = `codex/roundhouse-${job.id}`;
  if (report.branch !== expectedBranch) throw new Error(`Machine-local Herdr evidence must report branch ${expectedBranch}.`);
  if (typeof report.pushed !== "boolean") throw new Error("Machine-local Herdr evidence requires an explicit pushed boolean.");
  if (project.policy.shipping === "push_branch" && !report.pushed) throw new Error("Machine-local Herdr evidence did not confirm the required push.");
  if (project.policy.shipping === "commit_only" && report.pushed) throw new Error("Machine-local Herdr exceeded commit_only shipping authority.");
  if (!Array.isArray(report.checks)) throw new Error("Machine-local Herdr evidence requires verification checks.");
  const expected = project.verification.filter((rule) => !rule.roles || rule.roles.includes(job.agent_role ?? "general")).map((rule) => rule.id);
  if (report.checks.length !== expected.length || new Set(report.checks.map((check) => check?.id)).size !== report.checks.length ||
    expected.some((id) => !report.checks.some((check) => check?.id === id))) throw new Error("Machine-local Herdr evidence must report every applicable configured verification ID exactly once.");
  const checks = report.checks.map((check) => {
    if (check.passed !== true || typeof check.summary !== "string" || !check.summary.trim()) throw new Error(`Machine-local verification ${check.id} did not report passing evidence.`);
    return { id: check.id, source: "remote_agent", passed: true, summary: check.summary.trim(), artifacts: Array.isArray(check.artifacts) ? check.artifacts : [] };
  });
  const at = new Date().toISOString();
  const verification = { commit: report.commit, at, passed: true, independently_verified: false, checks };
  const shipping = { repository: null, working_directory: project.herdr.working_directory, branch: report.branch, commit: report.commit,
    policy: project.policy.shipping, remote: report.pushed ? project.remote : null, pr_url: null, deployment: null, verification,
    timestamp: at, pushed: report.pushed, source: "remote_agent_report", summary: report.summary.trim(), remote_execution: execution.remote_execution };
  return { verification, shipping };
}

function fallbackDecisionKey(decision) {
  if (decision.decision_key) return decision.decision_key;
  const text = [decision.decision, decision.project, decision.executor, decision.runtime, decision.shipping_policy, decision.question]
    .map((value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
  return `implicit:${digest(text).slice(0, 32)}`;
}

function executionProjectContext(project, role) {
  const context = projectContext(project, { role });
  return { ...context, agent_profile: composeAgentRole(role, project) };
}

function relatedWork(data, item) {
  const projectKeys = new Set([item.project_id, item.input?.project_id, item.input?.project_hint,
    item.project_candidate_id ? data.project_candidates?.[item.project_candidate_id]?.name : null].filter(Boolean).map((value) => String(value).toLowerCase()));
  return Object.values(data.items)
    .filter((candidate) => candidate.id !== item.id)
    .filter((candidate) => {
      const keys = [candidate.project_id, candidate.input?.project_id, candidate.input?.project_hint,
        candidate.project_candidate_id ? data.project_candidates?.[candidate.project_candidate_id]?.name : null]
        .filter(Boolean).map((value) => String(value).toLowerCase());
      return !projectKeys.size || keys.some((key) => projectKeys.has(key));
    })
    .slice(0, 50)
    .map((candidate) => ({
      id: candidate.id,
      state: candidate.state,
      project_id: candidate.project_id ?? null,
      legacy_roundhouse_id: candidate.legacy_depot?.["Roundhouse ID"] ?? candidate.provenance?.legacy_roundhouse_id ?? null,
      title: candidate.legacy_depot?.Item ?? candidate.decision?.work_items?.[0]?.title ?? candidate.input?.text?.split("\n")[0]?.slice(0, 200) ?? null,
      summary: candidate.input?.text?.slice(0, 500) ?? "",
      completed_at: candidate.completed_at ?? null,
      jobs: (candidate.job_ids ?? []).map((jobId) => data.jobs[jobId]).filter(Boolean).map((job) => ({
        id: job.id, state: job.state, title: job.work?.title ?? null, outcome: job.work?.outcome ?? null,
        commit: job.shipping?.commit ?? null, branch: job.shipping?.branch ?? null,
        output_reference: job.shipping?.reference ?? null, output_version: job.shipping?.version ?? null,
      })),
    }));
}

export class Engine {
  constructor({ store, config, decision = new DecisionProvider(config.decision), runtime, verifier = new CommandVerifier(), shipping = new DeliveryRouter({ directory: store.directory }), clock = () => Date.now() }) {
    const triage = { max_per_tick: 1, max_concurrent: 1, base_backoff_ms: 30_000, max_backoff_ms: 60 * 60_000, ...(config.triage ?? {}) };
    config.triage = triage;
    config.execution = { capacity: 1, capabilities: [], resource_limits: {}, ...(config.execution ?? {}) };
    const providers = config.execution.providers ?? [{ id: "local-project", kind: "project", capabilities: [...config.execution.capabilities] }];
    runtime ??= new CapabilityRuntime(providers, createRuntime());
    Object.assign(this, { store, config, decision, runtime, verifier, shipping, clock });
  }
  processRecorder(collection, id) {
    return (pid, launch = {}) => {
      const pending = this.store.change((data) => {
        const entity = data[collection][id];
        entity.processes ??= [];
        entity.processes.push({ pid, at: new Date().toISOString(), command: launch.command ?? null, cwd: launch.cwd ?? null,
          started_at: launch.started_at ?? null });
      });
      return pending;
    };
  }
  refreshScheduleEligibility(data) {
    const conditions = data.system_metadata?.condition_signals ?? {};
    for (const job of Object.values(data.jobs ?? {})) {
      if (job.state === "Ready") assessJobEligibility(job, conditions, { now: this.clock(), mutate: true });
    }
  }
  async decide(id, existingLease = null) {
    const decisionLease = this.store.shared && !existingLease
      ? await this.store.acquireLease("item", id, { operation: "decision" })
      : existingLease;
    if (this.store.shared && !decisionLease) throw new Error("Item is already owned by another decision worker.");
    const releaseDecisionLease = this.store.shared && !existingLease;
    let leaseHeartbeatError;
    const leaseHeartbeat = this.store.shared ? setInterval(() => {
      Promise.all([this.store.heartbeatLease(decisionLease), this.store.heartbeatNode("online")])
        .catch((error) => { leaseHeartbeatError = error; });
    }, Math.max(1_000, Math.floor(this.store.leaseMs / 3))) : null;
    leaseHeartbeat?.unref?.();
    try {
    await this.store.change((data) => {
      const item = data.items[id];
      if (item.state === "Decision" && item.awaiting_decision) item.awaiting_decision = false;
      else {
        if (!["Depot", "Needs Clarification", "Blocked"].includes(item.state)) throw new Error("Item cannot be triaged in its current state.");
        this.store.move(data, item, "Decision", "Triage is evaluating the Depot request.");
      }
      item.triage ??= { attempts: [], failure_count: 0 };
      item.triage.attempts ??= [];
      const providerEvidence = configuredDecisionProviderEvidence(this.config.decision);
      const previousProviderId = item.triage.attempts.at(-1)?.provider_evidence?.selected?.id ?? null;
      const providerId = providerEvidence.selected?.id ?? null;
      const startedAt = new Date(this.clock()).toISOString();
      recordProviderTransition(item, previousProviderId, providerId, item.triage.attempts.length + 1, startedAt);
      item.triage.attempts.push({ number: item.triage.attempts.length + 1, item_revision: item.revision,
        started_at: startedAt, node_id: this.store.node?.id ?? null, node_name: this.store.node?.name ?? null,
        provider_evidence: providerEvidence });
      item.triage.status = "evaluating";
      item.triage.retry_requested_at = null;
      item.triage.next_attempt_at = null;
    });
    try {
      const snapshot = await this.store.read();
      const item = snapshot.items[id];
      const projects = this.config.projects.map((project) => projectContext(project));
      const selectedProject = item.selected_project ?? item.input.project_id;
      await this.store.change((data) => {
        const attempt = data.items[id].triage?.attempts?.at(-1);
        if (attempt?.provider_evidence?.selected) {
          attempt.provider_evidence.invoked = structuredClone(attempt.provider_evidence.selected);
          attempt.provider_evidence.invoked_at = new Date(this.clock()).toISOString();
        }
      });
      const proposed = await this.decision.decide({ item: { ...item, related_work: relatedWork(snapshot, item),
        input: { ...item.input, ...(selectedProject ? { project_id: selectedProject } : {}) } }, projects,
        directory: path.join(this.store.directory, "decisions", id, String(item.revision)), onStart: this.processRecorder("items", id) });
      const configuredProject = this.config.projects.find((project) => project.id === proposed.project);
      const role = configuredProject ? inferAgentRole({ item, decision: proposed, project: configuredProject }) : "general";
      const project = configuredProject ? executionProjectContext(configuredProject, role) : null;
      const modeledDecision = project ? inferRoutineAcceptanceCriteria(proposed, project, item, role) : proposed;
      const latest = (await this.store.read()).items[id].triage?.attempts?.at(-1);
      const decision = modeledDecision;
      const decisionProviderEvidence = structuredClone(latest?.provider_evidence ?? configuredDecisionProviderEvidence(this.config.decision));
      let route = routeDecision(decision, project ? [project] : projects, selectedProject);
      const executionEligibilityReasons = route.state === "Ready" && project
        ? decision.work_items.flatMap((work) => executionEligibility(project, this.config.execution,
          this.config.execution.capabilities, { work }).reasons)
        : [];
      if (leaseHeartbeatError) throw leaseHeartbeatError;
      if (this.store.shared) await this.store.assertLease(decisionLease);
      await this.store.change((data) => {
        const current = data.items[id];
        current.questions ??= [];
        const proposedQuestions = decision.questions.length ? decision.questions : (decision.question ? [{
          prompt: decision.question,
          decision_key: decision.decision_key ?? fallbackDecisionKey(decision),
        }] : []);
        const decisionKey = proposedQuestions[0]?.decision_key ?? decision.decision_key ?? null;
        const resolvedKeys = new Set(current.questions
          .filter((question) => question.status === "answered" && question.decision_key)
          .map((question) => question.decision_key));
        const repeated = proposedQuestions.find((question) => resolvedKeys.has(question.decision_key));
        if (repeated && ["Needs Clarification", "Review"].includes(route.state)) {
          this.store.move(data, current, "Blocked", `Decision provider repeated already resolved decision ${repeated.decision_key}.`);
          current.processes = [];
          current.execution_eligible = false;
          const attempt = current.triage?.attempts?.at(-1);
          if (attempt) {
            attempt.finished_at = new Date(this.clock()).toISOString();
            attempt.outcome = "Blocked";
            attempt.reason = current.history.at(-1).reason;
          }
          current.triage.status = "Blocked";
          current.triage.reason = current.history.at(-1).reason;
          current.triage.last_evaluated_revision = current.revision;
          current.triage.failure_count = 0;
          current.triage.last_error = null;
          current.triage.next_attempt_at = null;
          current.triage.blocked_fingerprint = triageFingerprint(current, data, this.config, this.store);
          return;
        }
        current.decision_history ??= [];
        if (current.decision) current.decision_history.push(current.decision);
        current.decision = { ...decision, provider_evidence: decisionProviderEvidence };
        current.decision_key = decisionKey;
        current.decision_id = randomUUID();
        current.project_id = project?.id ?? null;
        current.policy_hash = project ? digest(project) : null;
        current.project_context = project ?? null;
        current.agent_role = project ? role : null;
        current.processes = [];
        if (route.state === "Reconciled") {
          const target = exactReconciliationTarget(data, current, decision.reconcile_with);
          if (target) {
            current.reconciled_with = target.id;
            current.provenance = current.provenance ? { ...current.provenance, reconciled: true } : current.provenance;
            route = { state: "Reconciled", reason: `${route.reason} Exact durable target: ${target.id}.` };
          } else route = { state: "Blocked", reason: "Reconciliation was refused because no exact durable/provenance identity matched the proposed target." };
        }
        const unconfiguredHint = !project && (current.project_candidate_id || selectedProject || current.input.project_hint);
        if (unconfiguredHint && !current.project_candidate_id) {
          data.project_candidates ??= {};
          const label = current.input.project_hint ?? selectedProject;
          const candidateId = `native-${digest(String(label).toLowerCase()).slice(0, 16)}`;
          data.project_candidates[candidateId] ??= { id: candidateId, name: String(label), status: "candidate", executable: false,
            source_system: current.input.source ?? "native", first_seen_at: new Date(this.clock()).toISOString(), source_ids: [current.id], record_count: 1 };
          current.project_candidate_id = candidateId;
        }
        if (unconfiguredHint && !["Review", "Archived", "Reconciled"].includes(route.state)
          && (route.state !== "Needs Clarification" || proposedQuestions.length === 0)) {
          route = { state: "Blocked", reason: "The referenced project is a non-executable project candidate and has no active runtime configuration." };
        }
        if (decision.dependencies.some((dependency) => !data.jobs[dependency])) {
          this.store.move(data, current, "Needs Clarification", "Decision referenced unknown dependencies.");
        } else {
          this.store.move(data, current, route.state, route.reason);
          current.execution_eligible = route.state === "Ready" && executionEligibilityReasons.length === 0;
          current.execution_ineligibility_reasons = executionEligibilityReasons;
          if (route.state === "Ready") this.createJobs(data, current);
        }
        if (["Needs Clarification", "Review"].includes(current.state)) {
          for (const question of current.questions) {
            if (question.status === "open") {
              question.status = "superseded";
              question.revision += 1;
              question.updated_at = new Date().toISOString();
            }
          }
          const now = new Date().toISOString();
          const questions = (proposedQuestions.length ? proposedQuestions : [{
            prompt: current.history.at(-1).reason,
            decision_key: decisionKey ?? fallbackDecisionKey(decision),
          }]).map((proposedQuestion) => ({
            id: randomUUID(),
            decision_id: current.decision_id,
            decision_key: proposedQuestion.decision_key,
            item_id: current.id,
            item_revision: current.revision,
            revision: 1,
            kind: current.state === "Review" ? "review" : "clarification",
            prompt: proposedQuestion.prompt.trim(),
            status: "open",
            created_at: now,
            updated_at: now,
          }));
          current.questions.push(...questions);
          const outbox = data.outbox.findLast((event) => event.entity_id === current.id && event.state === current.state);
          if (outbox) {
            outbox.question_id = questions[0].id;
            outbox.question_revision = questions[0].revision;
            outbox.question_count = questions.length;
          }
        }
        const attempt = current.triage?.attempts?.at(-1);
        if (attempt) {
          attempt.finished_at = new Date(this.clock()).toISOString();
          attempt.outcome = current.state;
          attempt.reason = current.history.at(-1)?.reason ?? route.reason;
        }
        current.triage ??= { attempts: [] };
        current.triage.status = current.state;
        current.triage.reason = current.history.at(-1)?.reason ?? route.reason;
        current.triage.last_evaluated_revision = current.revision;
        current.triage.failure_count = 0;
        current.triage.last_error = null;
        current.triage.next_attempt_at = null;
        current.triage.blocked_on = decision.blocked_on ?? [];
        current.triage.interrupted = false;
        current.triage.blocked_fingerprint = current.state === "Blocked" ? triageFingerprint(current, data, this.config, this.store) : null;
      });
    } catch (error) {
      if (this.store.shared) await this.store.assertLease(decisionLease);
      await this.store.change((data) => {
        const current = data.items[id];
        const failures = (current.triage?.failure_count ?? 0) + 1;
        const delay = triageBackoff(this.config, failures);
        if (current.state === "Decision") this.store.move(data, current, "Depot", `Triage failed; retry deferred for ${delay}ms: ${error.message}`);
        current.processes = [];
        current.triage ??= { attempts: [] };
        const attempt = current.triage.attempts?.at(-1);
        if (attempt) { attempt.finished_at = new Date(this.clock()).toISOString(); attempt.error = error.message; }
        current.triage.status = "backoff";
        current.triage.failure_count = failures;
        current.triage.last_error = error.message;
        current.triage.next_attempt_at = new Date(this.clock() + delay).toISOString();
      });
    }
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      if (releaseDecisionLease) await this.store.releaseLease(decisionLease).catch(() => {});
    }
  }
  createJobs(data, item) {
    item.job_ids = item.decision.work_items.map((work, index) => {
      const id = `${item.id}-${index + 1}`;
      if (data.jobs[id]) throw new Error("Work already exists for this decision.");
      const classification = classifyAction(work);
      const approval = item.approval ? { actor: item.approval.actor, item_revision: item.approval.revision,
        approved_at: item.approval.at, scope_digest: approvalScope(work, item.policy_hash) } : null;
      const policy = actionPolicy(work, item.policy_hash, approval);
      const requiredCapabilities = requiredExecutionCapabilities(item.project_context, { work });
      const providerEvidence = executionProviderEvidence(this.config.execution.providers, requiredCapabilities);
      data.jobs[id] = record(id, { state: classification === "human_task" ? "Review" : "Ready", parent_id: item.id, project_id: item.project_id,
        work, agent_role: item.agent_role ?? "general", project_context: item.project_context, policy_hash: item.policy_hash,
        provider_evidence: providerEvidence, provider_transitions: [],
        action_policy: policy,
        ...(classification === "human_task" ? { human_task: { status: "unassigned", assignment: null, evidence: [], completion: null,
          history: [{ from: null, to: "unassigned", actor: item.approval?.actor ?? null, at: new Date().toISOString(),
            reason: "Approved human work awaits durable assignment." }] } } : {}),
        input_digest: digest({ input: item.input, clarifications: item.clarifications, work }),
        dependencies: [...item.decision.dependencies, ...(index ? [`${item.id}-${index}`] : [])],
        attempts: [], processes: [], priority_rank: priorityRank(item), position: Object.keys(data.jobs).length });
      initializeJobSchedule(data.jobs[id], work.schedule, data.system_metadata?.condition_signals ?? {}, { now: this.clock() });
      return id;
    });
  }
  signalCondition(key, { satisfied = true, actor, details = null } = {}) {
    return this.store.change((data) => recordConditionSignal(data, key, { satisfied, actor, details, at: this.clock() }));
  }
  async nextScheduledWake() {
    return nextScheduledWake(await this.store.read(), { now: this.clock() });
  }
  approve(id, revision, actor) {
    if (!actor?.trim()) throw new Error("Approval requires an actor.");
    return this.store.change((data) => {
      const item = data.items[id];
      if (!item || item.state !== "Review" || item.revision !== revision) throw new Error("Approval must reference the current Review revision.");
      const project = this.config.projects.find((p) => p.id === item.project_id);
      const contextualProject = project ? executionProjectContext(project, item.agent_role ?? "general") : null;
      if (!contextualProject || digest(contextualProject) !== item.policy_hash) throw new Error("Project context/policy changed. Clarify and re-decide first.");
      // Human approval resolves authority, not missing verification or confidence.
      const { provider_evidence: _providerEvidence, ...storedDecision } = item.decision;
      const decision = { ...storedDecision, safe_to_execute: true, approval_required: false, decision: "execute" };
      const authorized = { ...contextualProject, policy: { ...contextualProject.policy, allow_autonomous: true, approval_required: false } };
      const route = routeDecision(decision, [authorized], item.selected_project ?? item.input.project_id, { approved: true });
      if (route.state !== "Ready") throw new Error(`Approval cannot bypass readiness: ${route.reason}`);
      const eligibilityReasons = decision.work_items.flatMap((work) => executionEligibility(authorized, this.config.execution,
        this.config.execution.capabilities, { work }).reasons);
      item.approval = { actor, revision, at: new Date().toISOString() };
      const question = (item.questions ?? []).findLast((candidate) => candidate.status === "open");
      if (question) {
        question.answer = { text: "Approved", actor, at: item.approval.at };
        question.status = "answered";
        question.revision += 1;
        question.updated_at = item.approval.at;
      }
      this.store.move(data, item, "Ready", `Approved by ${actor}.`);
      item.execution_eligible = eligibilityReasons.length === 0;
      item.execution_ineligibility_reasons = eligibilityReasons;
      this.createJobs(data, item);
      data.projects[item.project_id] ??= {};
      return item;
    });
  }
  assignHumanTask(id, revision, assignee, actor) {
    if (!assignee?.trim() || !actor?.trim()) throw new Error("Human-task assignment requires an assignee and actor.");
    return this.store.change((data) => {
      const job = data.jobs[id];
      if (!job?.human_task || job.state !== "Review" || job.revision !== revision) {
        throw new Error("Assignment must reference the current human-task revision.");
      }
      const policy = actionPolicy(job.work, job.policy_hash, job.action_policy?.approval ?? null);
      if (!policy.authorized || policy.scope_digest !== job.action_policy?.scope_digest) {
        throw new Error("Human task is not covered by current revision-bound approval.");
      }
      if (job.human_task.status === "completed") throw new Error("Completed human tasks cannot be reassigned.");
      const now = new Date().toISOString();
      const from = job.human_task.status;
      job.human_task.status = "assigned";
      job.human_task.assignment = { assignee: assignee.trim(), actor: actor.trim(), assigned_at: now };
      job.human_task.history.push({ from, to: "assigned", actor: actor.trim(), assignee: assignee.trim(), at: now });
      job.revision += 1;
      job.updated_at = now;
      return job;
    });
  }
  completeHumanTask(id, revision, { actor, summary, evidence } = {}) {
    if (!actor?.trim() || !summary?.trim()) throw new Error("Human-task completion requires an actor and summary.");
    if (!Array.isArray(evidence) || !evidence.length || evidence.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
      || !entry.kind?.trim() || !entry.reference?.trim())) {
      throw new Error("Human-task completion requires durable evidence entries with kind and reference.");
    }
    return this.store.change((data) => {
      const job = data.jobs[id];
      if (!job?.human_task || job.state !== "Review" || job.revision !== revision) {
        throw new Error("Completion must reference the current human-task revision.");
      }
      if (job.human_task.status !== "assigned" || !job.human_task.assignment) throw new Error("Human task must be assigned before completion.");
      const policy = actionPolicy(job.work, job.policy_hash, job.action_policy?.approval ?? null);
      if (!policy.authorized || policy.scope_digest !== job.action_policy.scope_digest) {
        throw new Error("Human task approval is stale for its current scope.");
      }
      const now = new Date().toISOString();
      job.human_task.evidence = structuredClone(evidence);
      job.human_task.completion = { actor: actor.trim(), summary: summary.trim(), completed_at: now };
      job.human_task.history.push({ from: "assigned", to: "completed", actor: actor.trim(), at: now, summary: summary.trim() });
      job.human_task.status = "completed";
      job.shipping = { provider: "human-task", policy: "human_completion", pushed: false, result: { summary: summary.trim() },
        evidence: structuredClone(evidence), verification: { passed: true, checks: evidence.map((entry, index) => ({
          id: `human-evidence-${index + 1}`, passed: true, source: "human", summary: `${entry.kind}: ${entry.reference}`,
        })) }, timestamp: now };
      this.store.move(data, job, "Shipped", `Human task completed by ${actor.trim()} with durable evidence.`);
      const parent = data.items[job.parent_id];
      if (parent.job_ids.every((key) => data.jobs[key].state === "Shipped")) parent.completed_at = now;
      return job;
    });
  }
  clarify(id, text, actor, projectId) {
    if (!text?.trim() || !actor?.trim()) throw new Error("Clarification needs text and actor.");
    return this.store.change((data) => {
      const item = data.items[id];
      if (!item || !["Needs Clarification", "Review"].includes(item.state) || item.job_ids.length) throw new Error("Item cannot be clarified here.");
      const now = new Date().toISOString();
      const question = (item.questions ?? []).findLast((candidate) => candidate.status === "open");
      if (question) {
        question.answer = { text, actor, at: now };
        question.status = "answered";
        question.revision += 1;
        question.updated_at = now;
      }
      item.clarifications.push({ text, actor, project_id: projectId ?? null, question_id: question?.id ?? null, decision_key: question?.decision_key ?? null, at: now });
      if (projectId) {
        if (!this.config.projects.some((p) => p.id === projectId)) throw new Error("Unknown project.");
        // Original input remains immutable; the provider receives this explicit correction.
        item.selected_project = projectId;
      }
      this.store.move(data, item, "Decision", "Human clarification received.");
      // Re-entered by the next run without automatically repeating an interrupted decision.
      item.awaiting_decision = true;
      return item;
    });
  }
  async answerQuestion(id, answer, actor, expectedRevision, origin = null) {
    if (!id?.trim() || !answer?.trim() || !actor?.trim()) throw new Error("Answer requires an id, answer, and actor.");
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Answer requires a positive expected revision.");
    const release = this.store.shared ? () => {} : this.store.acquireWorkerLease();
    let itemId;
    let itemLease;
    try {
      if (this.store.shared) {
        const snapshot = await this.store.read();
        const matches = Object.values(snapshot.items).filter((item) =>
          (item.questions ?? []).some((question) => question.id === id || question.decision_id === id));
        if (matches.length !== 1) throw new Error("Question or decision id does not identify one durable question.");
        itemId = matches[0].id;
        itemLease = await this.store.acquireLease("item", itemId, { operation: "answer" });
        if (!itemLease) throw new Error("Item is already owned by another decision worker.");
      }
      await this.store.change((data) => {
        const matches = Object.values(data.items).flatMap((item) =>
          (item.questions ?? []).filter((question) => question.id === id || question.decision_id === id).map((question) => ({ item, question })),
        );
        if (matches.length !== 1) throw new Error("Question or decision id does not identify one durable question.");
        const { item, question } = matches[0];
        if (origin && (item.input.source !== origin.source || item.input.thread_id !== origin.thread_id
          || item.input.correlation_id !== origin.correlation_id
          || (origin.project_id !== undefined && item.input.project_id !== origin.project_id))) {
          throw new Error("Question does not belong to the originating Claude conversation.");
        }
        if (question.status !== "open" || question.revision !== expectedRevision) throw new Error("Answer is stale or this question was already resolved.");
        const importedDecision = item.state === "Imported Pending" && question.kind === "imported_decision" && item.requires_reevaluation;
        if ((!importedDecision && !["Needs Clarification", "Review"].includes(item.state)) || item.job_ids.length) throw new Error("Question cannot be answered in the item's current state.");
        const now = new Date().toISOString();
        question.answer = { text: answer, actor, at: now,
          ...(origin ? { source: origin.source, thread_id: origin.thread_id, correlation_id: origin.correlation_id } : {}) };
        question.status = "answered";
        question.revision += 1;
        question.updated_at = now;
        item.clarifications.push({ text: answer, actor, question_id: question.id, decision_id: question.decision_id, decision_key: question.decision_key ?? null, at: now,
          ...(origin ? { source: origin.source, thread_id: origin.thread_id, correlation_id: origin.correlation_id } : {}) });
        if (importedDecision) {
          item.reevaluation = { actor, at: now, trigger: "imported_decision_answer" };
          item.requires_reevaluation = false;
          item.execution_eligible = true;
          this.store.move(data, item, "Depot", "Imported decision answered; explicit Roundhouse re-evaluation started.");
        } else {
          this.store.move(data, item, "Decision", "Human answer received; re-evaluating readiness.");
          item.awaiting_decision = true;
        }
        itemId = item.id;
      });
      await this.decide(itemId, itemLease);
      return (await this.store.read()).items[itemId];
    } finally {
      if (itemLease) await this.store.releaseLease(itemLease).catch(() => {});
      release();
    }
  }
  async answerDecisionSession(itemId, expectedItemRevision, answers, actor) {
    if (!itemId?.trim() || !actor?.trim()) throw new Error("Decision session requires an item id and actor.");
    if (!Number.isInteger(expectedItemRevision) || expectedItemRevision < 1) throw new Error("Decision session requires a positive item revision.");
    if (!Array.isArray(answers) || !answers.length) throw new Error("Decision session requires at least one answer.");
    for (const answer of answers) {
      if (!answer || typeof answer !== "object" || !answer.question_id?.trim() || !Number.isInteger(answer.expected_revision) || answer.expected_revision < 1 || !answer.answer?.trim()) {
        throw new Error("Every decision answer requires a question id, positive revision, and nonempty answer.");
      }
      if (answer.answer.length > 100_000) throw new Error("Decision answer exceeds 100,000 characters.");
    }
    if (new Set(answers.map((answer) => answer.question_id)).size !== answers.length) throw new Error("Decision session contains duplicate question ids.");
    const release = this.store.shared ? () => {} : this.store.acquireWorkerLease();
    let itemLease;
    try {
      if (this.store.shared) {
        itemLease = await this.store.acquireLease("item", itemId, { operation: "decision-session" });
        if (!itemLease) throw new Error("Item is already owned by another decision worker.");
      }
      await this.store.change((data) => {
        const item = data.items[itemId];
        const open = (item?.questions ?? []).filter((question) => question.status === "open");
        const conflict = (message) => {
          throw new RoundhouseError("decision_session_conflict", message, {
            item_id: itemId,
            current_item_revision: item?.revision ?? null,
            questions: open.map((question) => ({ id: question.id, revision: question.revision, prompt: question.prompt })),
          });
        };
        if (!item) conflict("This work item no longer exists.");
        if (item.revision !== expectedItemRevision) conflict("This work item changed while the decision session was open.");
        if (item.job_ids.length) conflict("Work has already started; no answers were applied.");
        const imported = item.state === "Imported Pending" && item.requires_reevaluation;
        if (!imported && !["Needs Clarification", "Review"].includes(item.state)) conflict("This item is no longer awaiting these decisions.");
        if (open.length !== answers.length || open.some((question, index) => question.id !== answers[index].question_id || question.revision !== answers[index].expected_revision)) {
          conflict("The ordered question set changed while the decision session was open.");
        }
        const now = new Date().toISOString();
        for (let index = 0; index < open.length; index += 1) {
          const question = open[index];
          const answer = answers[index].answer;
          question.answer = { text: answer, actor, at: now };
          question.status = "answered";
          question.revision += 1;
          question.updated_at = now;
          item.clarifications.push({ text: answer, actor, question_id: question.id, decision_id: question.decision_id,
            decision_key: question.decision_key ?? null, decision_session_position: index + 1, at: now });
        }
        item.decision_sessions ??= [];
        item.decision_sessions.push({ id: randomUUID(), actor, at: now, item_revision: expectedItemRevision,
          answers: open.map((question) => ({ question_id: question.id, decision_key: question.decision_key, revision: question.revision - 1 })) });
        if (imported) {
          item.reevaluation = { actor, at: now, trigger: "imported_decision_session" };
          item.requires_reevaluation = false;
          item.execution_eligible = true;
          this.store.move(data, item, "Depot", `${open.length} imported decision answer${open.length === 1 ? "" : "s"} received; explicit Roundhouse re-evaluation started.`);
        } else {
          this.store.move(data, item, "Decision", `${open.length} human answer${open.length === 1 ? "" : "s"} received; re-evaluating readiness.`);
          item.awaiting_decision = true;
        }
      });
      await this.decide(itemId, itemLease);
      return (await this.store.read()).items[itemId];
    } finally {
      if (itemLease) await this.store.releaseLease(itemLease).catch(() => {});
      release();
    }
  }
  async reconsider(id, actor = "system", expectedRevision) {
    if (!actor?.trim()) throw new Error("Reconsideration requires an actor.");
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Reconsideration requires a positive expected revision.");
    const release = this.store.shared ? () => {} : this.store.acquireWorkerLease();
    let itemLease;
    try {
      if (this.store.shared) {
        itemLease = await this.store.acquireLease("item", id, { operation: "reconsider" });
        if (!itemLease) throw new Error("Item is already owned by another decision worker.");
      }
      await this.store.change((data) => {
        const item = data.items[id];
        if (!item || item.state !== "Needs Clarification" || item.job_ids.length || item.revision !== expectedRevision) throw new Error("Only the current unstarted clarification revision can be reconsidered.");
        const now = new Date().toISOString();
        for (const question of item.questions ?? []) {
          if (question.status !== "open") continue;
          question.status = "superseded";
          question.revision += 1;
          question.updated_at = now;
          question.superseded_by = actor;
        }
        this.store.move(data, item, "Decision", `Re-evaluating readiness after a Roundhouse capability update (${actor}).`);
        item.awaiting_decision = true;
      });
      await this.decide(id, itemLease);
      return (await this.store.read()).items[id];
    } finally {
      if (itemLease) await this.store.releaseLease(itemLease).catch(() => {});
      release();
    }
  }
  async reevaluateImported(id, expectedRevision, actor = "local-user") {
    if (!actor?.trim()) throw new Error("Imported work re-evaluation requires an actor.");
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Imported work re-evaluation requires a positive expected revision.");
    const release = this.store.shared ? () => {} : this.store.acquireWorkerLease();
    let itemLease;
    try {
      if (this.store.shared) {
        itemLease = await this.store.acquireLease("item", id, { operation: "reevaluate-import" });
        if (!itemLease) throw new Error("Item is already owned by another decision worker.");
      }
      await this.store.change((data) => {
        const item = data.items[id];
        if (!item || item.state !== "Imported Pending" || !item.requires_reevaluation || item.revision !== expectedRevision || item.job_ids.length) {
          throw new Error("Only the current unstarted Imported Pending revision can be re-evaluated.");
        }
        item.execution_eligible = true;
        item.reevaluation = { actor, at: new Date().toISOString() };
        this.store.move(data, item, "Depot", `Explicit Roundhouse re-evaluation requested by ${actor}.`);
        item.requires_reevaluation = false;
      });
      await this.decide(id, itemLease);
      return (await this.store.read()).items[id];
    } finally {
      if (itemLease) await this.store.releaseLease(itemLease).catch(() => {});
      release();
    }
  }
  retryTriage(id, expectedRevision, actor = "local-user") {
    if (!actor?.trim()) throw new Error("Triage retry requires an actor.");
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Triage retry requires a positive expected revision.");
    return this.store.change((data) => {
      const item = data.items[id];
      if (!item || item.revision !== expectedRevision || item.job_ids?.length || !["Depot", "Blocked"].includes(item.state)) {
        throw new Error("Only the current unstarted Depot or Blocked revision can be retried.");
      }
      item.triage ??= { attempts: [], failure_count: 0 };
      item.triage.retry_requested_at = new Date(this.clock()).toISOString();
      item.triage.retry_requested_by = actor;
      item.triage.next_attempt_at = null;
      return item;
    });
  }
  async triageItem(id, existingLease = null) {
    const itemLease = this.store.shared && !existingLease
      ? await this.store.acquireLease("item", id, { operation: "triage" })
      : existingLease;
    if (this.store.shared && !itemLease) return false;
    const releaseLease = this.store.shared && !existingLease;
    try {
      let eligible = false;
      await this.store.change((data) => {
        const item = data.items[id];
        if (!item) return;
        const fingerprint = triageFingerprint(item, data, this.config, this.store);
        const selected = selectTriageCandidates({ ...data, items: { [id]: item } }, this.config, this.store,
          { now: this.clock(), limit: 1 });
        if (!selected.length) return;
        data.system_metadata ??= {};
        const scheduler = data.system_metadata.triage_scheduler ?? { sequence: 0 };
        scheduler.sequence += 1;
        scheduler.last_selected_at = new Date(this.clock()).toISOString();
        scheduler.last_item_id = id;
        data.system_metadata.triage_scheduler = scheduler;
        item.triage ??= { attempts: [], failure_count: 0 };
        item.triage.last_selected_sequence = scheduler.sequence;
        item.triage.selection_fingerprint = fingerprint;
        if (item.state === "Imported Pending") {
          const now = new Date(this.clock()).toISOString();
          for (const question of item.questions ?? []) {
            if (question.status !== "open") continue;
            question.status = "superseded";
            question.revision += 1;
            question.updated_at = now;
            question.superseded_by = "continuous-triage";
          }
          item.imported_release = {
            actor: "continuous-triage",
            at: now,
            from_revision: item.revision,
            provenance: item.provenance ? { source_system: item.provenance.source_system, source_id: item.provenance.source_id } : null,
            legacy_status: item.legacy_depot?.Status ?? null,
            legacy_workflow_state: item.legacy_depot?.["Workflow State"] ?? null,
            reason: "Safe explicit triage release; legacy readiness is context only and grants no execution authority.",
          };
          item.reevaluation = { actor: "continuous-triage", at: now, trigger: "continuous_imported_pending" };
          item.requires_reevaluation = false;
          item.execution_eligible = false;
          this.store.move(data, item, "Depot", "Imported Pending released for explicit Roundhouse triage; legacy status is evidence, not execution authority.");
        }
        eligible = true;
      });
      if (!eligible) return false;
      await this.decide(id, itemLease);
      return true;
    } finally {
      if (releaseLease) await this.store.releaseLease(itemLease).catch(() => {});
    }
  }
  async runTriage({ projectId, limit = this.config.triage.max_per_tick } = {}) {
    if (projectId && !this.config.projects.some((project) => project.id === projectId)) throw new Error("Unknown project filter.");
    const release = this.store.shared ? () => {} : this.store.acquireTriageLease();
    try {
      if (this.store.shared) {
        await this.store.heartbeatNode("online");
        await this.store.recoverExpiredClaims();
      }
      const snapshot = await this.store.read();
      const candidates = selectTriageCandidates(snapshot, this.config, this.store, { now: this.clock(), limit, projectId });
      let triaged = 0;
      for (let offset = 0; offset < candidates.length; offset += this.config.triage.max_concurrent) {
        const batch = candidates.slice(offset, offset + this.config.triage.max_concurrent);
        const outcomes = await Promise.all(batch.map(async ({ item }) => {
          if (!this.store.shared) return this.triageItem(item.id);
          const lease = await this.store.acquireLease("item", item.id, { operation: "triage" });
          if (!lease) return false;
          try { return await this.triageItem(item.id, lease); }
          finally { await this.store.releaseLease(lease).catch(() => {}); }
        }));
        triaged += outcomes.filter(Boolean).length;
      }
      const state = await this.store.read();
      return { triaged, triage_limit_reached: Number.isFinite(limit) && triaged >= limit, ...state };
    } finally { release(); }
  }
  async execute(id, project, jobLease = null) {
    const machineLocal = isMachineLocal(project);
    let releaseRepo;
    let projectLease;
    let heartbeatTimer;
    let heartbeatError;
    try {
      if (this.store.shared) {
        projectLease = await this.store.acquireLease("project", project.id, { job_id: id });
        if (!projectLease) return false;
        heartbeatTimer = setInterval(() => {
          Promise.all([this.store.heartbeatLease(projectLease), jobLease ? this.store.heartbeatLease(jobLease) : null,
            this.store.heartbeatNode("online")])
            .catch((error) => { heartbeatError = error; });
        }, Math.max(1_000, Math.floor(this.store.leaseMs / 3)));
        heartbeatTimer.unref?.();
      }
      if (!machineLocal) {
        releaseRepo = this.shipping.lock(project, (await this.store.read()).jobs[id]);
        await this.store.change((data) => { data.projects[project.id].repository_lock = releaseRepo.directory ?? `postgresql:project/${project.id}`; });
      }
      const state = await this.store.read();
      const job = state.jobs[id];
      if (digest(executionProjectContext(project, job.agent_role ?? "general")) !== job.policy_hash) throw new Error("Project policy or context changed after decision; resubmit for a new decision.");
      assertProviderAuthorized(job);
      if (!machineLocal && !this.shipping.supports(project, job)) throw new Error(`Shipping policy ${project.policy.shipping} has no installed provider.`);
      const prepared = machineLocal
        ? { kind: "machine_local", branch: `codex/roundhouse-${job.id}`, working_directory: project.herdr.working_directory }
        : this.shipping.prepare({ project, job, directory: path.join(this.store.directory, "workspaces"), base: state.projects[project.id]?.last_commit });
      await this.store.change((data) => { data.jobs[id].prepared = prepared; });
      for (let attempt = 0; attempt <= project.policy.max_rework_attempts; attempt++) {
        const current = (await this.store.read()).jobs[id];
        const requiredCapabilities = requiredExecutionCapabilities(project, current);
        const providerEvidence = executionProviderEvidence(this.config.execution.providers, requiredCapabilities);
        if (!providerEvidence.selected) throw new Error(`No execution provider supports the required capability combination: ${requiredCapabilities.length ? requiredCapabilities.join(", ") : "(none)"}.`);
        const run = { id: randomUUID(), job_id: id, attempt: attempt + 1, provider_id: providerEvidence.selected.id, status: "executing",
          input_digest: current.input_digest ?? digest({ work: current.work, project_context: current.project_context }),
          inputs: { work: structuredClone(current.work), project_context_digest: digest(current.project_context),
            previous_failure_attempt: current.attempts.at(-1)?.number ?? null },
          reconciliation: { required: false, status: "not_required" } };
        await this.store.change((data) => {
          const j = data.jobs[id];
          const previousProviderId = j.attempts.at(-1)?.provider_evidence?.selected?.id ?? j.provider_evidence?.selected?.id ?? null;
          recordProviderTransition(j, previousProviderId, providerEvidence.selected.id, attempt + 1, new Date().toISOString());
          j.provider_evidence = structuredClone(providerEvidence);
          this.store.move(data, j, "Executing", `Execution attempt ${attempt + 1}.`);
          j.attempts.push({ number: attempt + 1, run, started_at: new Date().toISOString(), status: "executing",
            node_id: this.store.node?.id ?? null, node_name: this.store.node?.name ?? null,
            provider_evidence: structuredClone(providerEvidence) });
        });
        let failure;
        let deliveryAttempted = false;
        try {
          const providerJob = (await this.store.read()).jobs[id];
          assertProviderAuthorized(providerJob);
          const onProviderStart = async (invokedProvider = providerEvidence.selected) => {
            const invokedIdentity = { ...providerEvidence.selected, ...invokedProvider,
              kind: invokedProvider?.kind ?? providerEvidence.selected.kind };
            await this.store.change((data) => {
              const recorded = data.jobs[id].attempts.at(-1);
              const selectedId = recorded.provider_evidence?.selected?.id;
              if (selectedId !== invokedIdentity.id) {
                throw new Error(`Execution provider cannot change within attempt ${recorded.number}: selected ${selectedId}, invoked ${invokedIdentity.id ?? "unknown"}.`);
              }
              if (recorded.provider_evidence.invoked && recorded.provider_evidence.invoked.id !== invokedIdentity.id) {
                throw new Error(`Execution provider cannot change within active attempt ${recorded.number}.`);
              }
              recorded.provider_evidence.invoked = structuredClone(invokedIdentity);
              recorded.provider_evidence.invoked_at ??= new Date().toISOString();
              data.jobs[id].provider_evidence = structuredClone(recorded.provider_evidence);
            });
          };
          await onProviderStart();
          const execution = await this.runtime.execute({ project, job: providerJob, workspace: prepared.workspace,
            directory: path.join(this.store.directory, "executions", id, String(attempt + 1)),
            previous_failure: current.attempts.at(-1) ?? null, run, onStart: this.processRecorder("jobs", id),
            onProviderStart,
            onRemoteStart: (remote_execution) => this.store.change((data) => {
              const j = data.jobs[id];
              j.attempts.at(-1).execution = { passed: null, started_at: new Date().toISOString(), remote_execution };
              if (machineLocal) j.delivery_intent = { mode: "machine_local", working_directory: project.herdr.working_directory,
                machine_selector: project.herdr.machine, agent_target: project.herdr.agent, branch: `codex/roundhouse-${id}`,
                policy: project.policy.shipping, report_token: remote_execution.report_token,
                recorded_at: new Date().toISOString(), reconciliation: { required_on_interruption: true, status: "remote_execution" } };
            }) });
          await this.store.change((data) => {
            const recorded = data.jobs[id].attempts.at(-1);
            if (execution.provider?.id && execution.provider.id !== recorded.provider_evidence?.selected?.id) {
              throw new Error(`Execution provider cannot change within attempt ${recorded.number}: selected ${recorded.provider_evidence?.selected?.id}, returned ${execution.provider.id}.`);
            }
            recorded.execution = execution;
            recorded.run.provider_id = execution.provider?.id ?? recorded.run.provider_id;
            recorded.status = execution.passed ? "executed" : "failed";
            recorded.run.status = recorded.status;
          });
          if (!execution.passed) throw new Error(execution.error ?? `Executor failed (exit ${execution.exit_code}).`);
          if (machineLocal) {
            const { verification, shipping } = machineLocalEvidence(project, providerJob, execution);
            await this.store.change((data) => {
              const j = data.jobs[id];
              const recorded = j.attempts.at(-1);
              recorded.status = "verifying";
              recorded.run.status = "verifying";
              this.store.move(data, j, "Verification", "Recording remote machine-local verification evidence.");
              recorded.verification = verification;
              recorded.status = "completed";
              recorded.run.status = "completed";
              recorded.finished_at = shipping.timestamp;
              j.shipping = shipping;
              j.delivery_intent.reconciliation = { required_on_interruption: false, status: "confirmed", confirmed_at: shipping.timestamp };
              j.processes = [];
              this.store.move(data, j, "Shipped", "Remote agent reported verified machine-local delivery; Roundhouse did not inspect the remote filesystem.");
              data.projects[project.id] = { ...data.projects[project.id], last_commit: shipping.commit,
                active: false, review_required: project.policy.review_after_shipping };
              const parent = data.items[j.parent_id];
              const { successor } = ensureNextOccurrence(data, j, { now: this.clock() });
              if (!successor && parent.job_ids.every((key) => data.jobs[key].state === "Shipped")) parent.completed_at = shipping.timestamp;
            });
            return true;
          }
          const snapshot = this.shipping.snapshot({ project, job: providerJob, prepared, execution, run });
          await this.store.change((data) => {
            data.jobs[id].attempts.at(-1).snapshot = snapshot;
            data.jobs[id].attempts.at(-1).status = "verifying";
            data.jobs[id].attempts.at(-1).run.status = "verifying";
            this.store.move(data, data.jobs[id], "Verification", "Verifying committed candidate.");
          });
          const verification = await this.verifier.verify({ project, job: providerJob, workspace: prepared.workspace, commit: snapshot.commit, snapshot, execution,
            directory: path.join(this.store.directory, "evidence", id, String(attempt + 1)), onStart: this.processRecorder("jobs", id) });
          if (!this.shipping.unchanged(prepared, snapshot.version ?? snapshot.commit)) {
            verification.passed = false;
            verification.checks.push({ id: "unchanged-tested-version", passed: false, stderr: "Verification modified the tested version or left uncommitted changes." });
          }
          await this.store.change((data) => {
            data.jobs[id].attempts.at(-1).verification = verification;
            data.jobs[id].attempts.at(-1).status = verification.passed ? "verified" : "failed";
            data.jobs[id].attempts.at(-1).run.status = data.jobs[id].attempts.at(-1).status;
          });
          if (!verification.passed) throw new Error("Required verification failed.");
          // Persist delivery intent before touching a remote. On crash this attempt is never replayed.
          await this.store.change((data) => { data.jobs[id].delivery_intent = {
            candidate: snapshot.version ?? snapshot.commit, commit: snapshot.commit ?? null, version: snapshot.version ?? null,
            branch: prepared.branch ?? null, policy: project.policy.shipping, provider: prepared.kind ?? "git",
            recorded_at: new Date().toISOString(), reconciliation: { required_on_interruption: true, status: "pending_delivery" },
          }; });
          if (heartbeatError) throw heartbeatError;
          if (this.store.shared) {
            await this.store.assertLease(projectLease);
            if (!jobLease) throw new Error("Shared execution has no authoritative job lease.");
            await this.store.assertLease(jobLease);
          }
          let delivered;
          deliveryAttempted = true;
          try { delivered = await this.shipping.ship({ project, job: providerJob, prepared, snapshot, execution, run, verification, onStart: this.processRecorder("jobs", id) }); }
          catch (error) { await this.block(id, `Delivery failed or uncertain: ${error.message}`); return true; }
          await this.store.change((data) => {
            const j = data.jobs[id];
            j.shipping = delivered;
            j.delivery_intent.reconciliation = { required_on_interruption: false, status: "confirmed", confirmed_at: delivered.timestamp };
            j.attempts.at(-1).status = "completed";
            j.attempts.at(-1).run.status = "completed";
            j.attempts.at(-1).finished_at = delivered.timestamp;
            j.processes = [];
            this.store.move(data, j, "Shipped", "Verified work delivered under project policy.");
            data.projects[project.id] = { ...data.projects[project.id], ...(delivered.commit ? { last_commit: delivered.commit } : {}),
              ...(delivered.reference ? { last_output: delivered.reference } : {}),
              active: false, review_required: project.policy.review_after_shipping };
            const parent = data.items[j.parent_id];
            const { successor } = ensureNextOccurrence(data, j, { now: this.clock() });
            if (!successor && parent.job_ids.every((key) => data.jobs[key].state === "Shipped")) {
              parent.completed_at = delivered.timestamp;
            }
          });
          return true;
        } catch (error) {
          if (machineLocal) {
            await this.store.change((data) => { data.jobs[id].attempts.at(-1).failure = error.message; });
            await this.block(id, `Machine-local Herdr outcome requires explicit reconciliation and will not be replayed automatically: ${error.message}`);
            return true;
          }
          if (deliveryAttempted) { await this.block(id, `Delivery outcome requires reconciliation: ${error.message}`); return true; }
          failure = error.message;
        }
        await this.store.change((data) => {
          const failed = data.jobs[id].attempts.at(-1);
          failed.failure = failure;
          failed.status = "failed";
          failed.run.provider_id ??= run.provider_id;
          failed.run.status = "failed";
          failed.finished_at = new Date().toISOString();
        });
        if (attempt === project.policy.max_rework_attempts) { await this.block(id, `Rework limit reached: ${failure}`); return true; }
        if ((await this.store.read()).projects[project.id]?.stop) { await this.block(id, "Operator stopped the project before automated rework."); return true; }
        await this.store.change((data) => this.store.move(data, data.jobs[id], "Rework", failure));
      }
      return true;
    } catch (error) { await this.block(id, error.message); return true; }
    finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (releaseRepo) {
        releaseRepo();
        await this.store.change((data) => { data.projects[project.id].repository_lock = null; });
      }
      if (projectLease) await this.store.releaseLease(projectLease).catch(() => {});
    }
  }
  block(id, reason) {
    return this.store.change((data) => {
      const job = data.jobs[id];
      if (job.delivery_intent) job.reconciliation = { required: true, status: "required", reason,
        intent: structuredClone(job.delivery_intent), recorded_at: new Date().toISOString() };
      const attempt = job.attempts.at(-1);
      if (attempt && attempt.status !== "completed") {
        attempt.failure ??= reason;
        if (attempt.status !== "failed") attempt.status = "blocked";
        attempt.finished_at ??= new Date().toISOString();
        if (attempt.run) attempt.run.status = attempt.status;
      }
      if (attempt?.run && job.reconciliation) attempt.run.reconciliation = job.reconciliation;
      this.store.move(data, job, "Blocked", reason);
      data.projects[job.project_id] = { ...data.projects[job.project_id], blocked: true, active: false };
    });
  }
  async run({ projectId } = {}) {
    const triage = await this.runTriage({ projectId, limit: Infinity });
    const dispatch = await this.runDispatch({ projectId });
    return { ...dispatch, triaged: triage.triaged };
  }
  async runDispatch({ projectId } = {}) {
    if (this.store.shared) return this.runSharedDispatch({ projectId });
    const release = this.store.acquireWorkerLease();
    let executed = 0;
    try {
      if (projectId && !this.config.projects.some((p) => p.id === projectId)) throw new Error("Unknown project filter.");
      const snapshot = await this.store.read();
      if (hasImportedTriageBarrier(snapshot)) return { executed: 0, triage_barrier: true, ...snapshot };
      if (Object.values(snapshot.jobs).some((job) => ["Executing", "Verification", "Rework"].includes(job.state))) throw new Error("Interrupted execution requires recovery, not automatic replay.");
      await this.store.change((data) => {
        schedulerState(data, this.config.execution.capacity);
        this.refreshScheduleEligibility(data);
      });
      const stopped = new Set();
      let started = 0;
      const running = new Set();
      const reservations = new Map();
      const settleOne = async () => {
        if (running.size) await Promise.race(running);
      };
      while (started < this.config.max_jobs_per_run || running.size) {
        if (started >= this.config.max_jobs_per_run) {
          await settleOne();
          continue;
        }
        if (running.size >= this.config.execution.capacity) {
          const state = await this.store.read();
          const waiting = dispatchConsiderations(state, this.config.projects, this.config.execution, {
            projectId,
            stopped,
            activeReservations: [...reservations.values()],
            canDispatch: (project) => isMachineLocal(project) || (this.shipping.canDispatch?.(project) ?? true),
            now: this.clock(),
          }).filter((entry) => !reservations.has(entry.job.id));
          if (waiting.length) await this.store.change((data) => recordDispatchRound(data, waiting, null,
            this.config.execution.capacity, new Date(this.clock()).toISOString()));
          await settleOne();
          continue;
        }
        const state = await this.store.read();
        const considerations = dispatchConsiderations(state, this.config.projects, this.config.execution, {
          projectId,
          stopped,
          activeReservations: [...reservations.values()],
          canDispatch: (project) => isMachineLocal(project) || (this.shipping.canDispatch?.(project) ?? true),
          now: this.clock(),
        });
        // Weighted turns across projects; only each project's queue head may compete.
        const selected = considerations.filter((entry) => entry.eligible)
          .sort((a, b) => a.fairness.weighted_allocation - b.fairness.weighted_allocation || a.project.id.localeCompare(b.project.id))[0];
        const at = new Date(this.clock()).toISOString();
        if (!selected) {
          if (considerations.length) await this.store.change((data) => recordDispatchRound(data, considerations, null, this.config.execution.capacity, at));
          if (running.size) { await settleOne(); continue; }
          break;
        }
        const { project, job } = selected;
        const reservation = executionReservation(project, job);
        await this.store.change((data) => {
          recordDispatchRound(data, considerations, job.id, this.config.execution.capacity, at);
          data.projects[project.id] = { ...data.projects[project.id], active: true };
          recordAllocation(data, project, this.config.execution.capacity, at);
          assessJobEligibility(data.jobs[job.id], data.system_metadata?.condition_signals ?? {}, { now: this.clock(), mutate: true });
          data.jobs[job.id].owning_node_id = this.store.node?.id ?? null;
          data.jobs[job.id].owning_node = this.store.node?.name ?? null;
        });
        started += 1;
        if (project.policy.continuation === "stop_after_job") stopped.add(project.id);
        let task;
        task = (async () => {
          try {
            if (await this.execute(job.id, project)) executed += 1;
          } finally {
            await this.store.change((data) => {
              data.jobs[job.id].owning_node_id = null;
              data.jobs[job.id].owning_node = null;
            });
            reservations.delete(job.id);
            running.delete(task);
          }
        })();
        reservations.set(job.id, reservation);
        running.add(task);
      }
      await Promise.all(running);
      return { executed, limit_reached: executed >= this.config.max_jobs_per_run, ...await this.store.read() };
    } finally { release(); }
  }

  async runSharedDispatch({ projectId } = {}) {
    let executed = 0;
    if (projectId && !this.config.projects.some((project) => project.id === projectId)) throw new Error("Unknown project filter.");
    await this.store.heartbeatNode("online");
    await this.store.recoverExpiredClaims();
    await this.store.change((data) => {
      schedulerState(data, this.config.execution.capacity);
      this.refreshScheduleEligibility(data);
    });

    let snapshot;
    const stopped = new Set();
    let started = 0;
    const running = new Set();
    const settleOne = async () => {
      if (!running.size) return;
      await Promise.race(running);
    };
    while (started < this.config.max_jobs_per_run || running.size) {
      if (started >= this.config.max_jobs_per_run) {
        await settleOne();
        continue;
      }
      if (running.size >= this.config.execution.capacity) {
        snapshot = await this.store.read();
        const activeReservations = Object.values(snapshot.jobs)
          .filter((job) => job.owning_node_id || ["Executing", "Verification", "Rework"].includes(job.state))
          .map((job) => ({ job, project: this.config.projects.find((project) => project.id === job.project_id) }))
          .filter(({ project }) => Boolean(project))
          .map(({ project, job }) => executionReservation(project, job));
        const waiting = dispatchConsiderations(snapshot, this.config.projects, this.config.execution, {
          projectId,
          stopped,
          activeReservations,
          canDispatch: (project) => isMachineLocal(project) || (this.shipping.canDispatch?.(project) ?? true),
          now: this.clock(),
        }).filter((entry) => !snapshot.jobs[entry.job.id]?.owning_node_id
          && !["Executing", "Verification", "Rework"].includes(snapshot.jobs[entry.job.id]?.state));
        if (waiting.length) await this.store.change((data) => recordDispatchRound(data, waiting, null,
          this.config.execution.capacity, new Date(this.clock()).toISOString()));
        await settleOne();
        continue;
      }
      snapshot = await this.store.read();
      if (hasImportedTriageBarrier(snapshot)) break;
      const activeReservations = Object.values(snapshot.jobs)
        .filter((job) => job.owning_node_id || ["Executing", "Verification", "Rework"].includes(job.state))
        .map((job) => ({ job, project: this.config.projects.find((project) => project.id === job.project_id) }))
        .filter(({ project }) => Boolean(project))
        .map(({ project, job }) => executionReservation(project, job));
      const considerations = dispatchConsiderations(snapshot, this.config.projects, this.config.execution, {
        projectId,
        stopped,
        activeReservations,
        canDispatch: (project) => isMachineLocal(project) || (this.shipping.canDispatch?.(project) ?? true),
        now: this.clock(),
      });
      const candidates = considerations.filter((entry) => entry.eligible)
        .sort((a, b) => a.fairness.weighted_allocation - b.fairness.weighted_allocation || a.project.id.localeCompare(b.project.id));
      const at = new Date(this.clock()).toISOString();
      if (!candidates.length) {
        if (considerations.length) await this.store.change((data) => recordDispatchRound(data, considerations, null, this.config.execution.capacity, at));
        if (running.size) { await settleOne(); continue; }
        break;
      }
      const reservations = Object.fromEntries(candidates.map(({ project, job }) => [job.id, executionReservation(project, job)]));
      const claim = await this.store.claimJob(candidates.map(({ job }) => job.id), {
        leaseMs: this.store.leaseMs,
        execution: this.config.execution,
        reservations,
        returnEvidence: true,
      });
      for (const evidence of claim?.claim_evidence ?? []) {
        const consideration = considerations.find((entry) => entry.job.id === evidence.job_id);
        if (!consideration) continue;
        consideration.reservation = { fits: evidence.fits, constraints: evidence.constraints };
        consideration.eligible = Object.values(consideration.checks).every((check) => check.passed) && evidence.fits;
      }
      if (!claim?.job) {
        await this.store.change((data) => recordDispatchRound(data, considerations, null, this.config.execution.capacity, at, {
          code: "atomic_claim_unavailable",
          message: "Another worker won the atomic claim or consumed a capacity, project, resource, or lock constraint.",
        }));
        if (running.size) { await settleOne(); continue; }
        break;
      }
      const project = candidates.find(({ job }) => job.id === claim.job.id)?.project;
      if (!project) throw new Error("Claimed job was not an eligible project queue head.");
      await this.store.change((data) => {
        recordDispatchRound(data, considerations, claim.job.id, this.config.execution.capacity, at);
        data.projects[project.id] = { ...data.projects[project.id], active: true };
        recordAllocation(data, project, this.config.execution.capacity, at);
        assessJobEligibility(data.jobs[claim.job.id], data.system_metadata?.condition_signals ?? {}, { now: this.clock(), mutate: true });
      });
      started += 1;
      if (project.policy.continuation === "stop_after_job") stopped.add(project.id);
      let task;
      task = (async () => {
        try {
          if (await this.execute(claim.job.id, project, claim.lease)) executed += 1;
        } finally {
          await this.store.releaseLease(claim.lease).catch(() => {});
          running.delete(task);
        }
      })();
      running.add(task);
    }
    await Promise.all(running);
    return { executed, limit_reached: executed >= this.config.max_jobs_per_run, ...await this.store.read() };
  }
}
