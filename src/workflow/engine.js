import path from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../storage/repository.js";
import { record } from "./state.js";
import { projectContext } from "./config.js";
import { DecisionProvider, inferRoutineAcceptanceCriteria, routeDecision } from "./decision.js";
import { createRuntime, CommandVerifier } from "./runtime.js";
import { GitDelivery, git } from "./delivery.js";
import { composeAgentRole, inferAgentRole } from "./roles.js";
import { RoundhouseError } from "../errors.js";
import { exactReconciliationTarget, hasImportedTriageBarrier, priorityRank, selectTriageCandidates, triageBackoff, triageFingerprint } from "./triage.js";
import { Unblocker } from "./unblocker.js";
import { projectExecutionEligible, recordAllocation, schedulerState, weightedAllocation } from "./scheduler.js";

const isMachineLocal = (project) => project.runtime === "herdr" && project.herdr?.workspace_mode === "machine_local";

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
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

function executionAuthorityContext(context = {}) {
  return {
    id: context.id ?? null,
    status: context.status ?? null,
    repository: context.repository ?? null,
    base_ref: context.base_ref ?? null,
    remote: context.remote ?? null,
    runtime: context.runtime ?? null,
    executor: context.executor ?? null,
    max_concurrent_runs: context.max_concurrent_runs ?? null,
    timeout_ms: context.timeout_ms ?? null,
    self_hosting: context.self_hosting ?? null,
    policy: context.policy ?? null,
    verification: context.verification ?? null,
    context_limits: context.context_limits ?? null,
    agent: {
      default_role: context.agent?.default_role ?? null,
      allowed_roles: context.agent?.allowed_roles ?? null,
    },
    herdr: context.herdr ?? null,
  };
}

function sameExecutionAuthority(left, right) {
  return digest(executionAuthorityContext(left)) === digest(executionAuthorityContext(right));
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
      })),
    }));
}

export class Engine {
  constructor({ store, config, decision = new DecisionProvider(config.decision), runtime = createRuntime(), verifier = new CommandVerifier(), shipping = new GitDelivery(), clock = () => Date.now() }) {
    const triage = { max_per_tick: 1, max_concurrent: 1, base_backoff_ms: 30_000, max_backoff_ms: 60 * 60_000, ...(config.triage ?? {}) };
    config.triage = triage;
    config.execution = { capacity: 1, capabilities: [], resource_limits: {}, ...(config.execution ?? {}) };
    Object.assign(this, { store, config, decision, runtime, verifier, shipping, clock });
  }
  processRecorder(collection, id) {
    return (pid) => {
      const pending = this.store.change((data) => {
        const entity = data[collection][id];
        entity.processes ??= [];
        entity.processes.push({ pid, at: new Date().toISOString() });
      });
      return pending;
    };
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
      item.triage.attempts.push({ number: item.triage.attempts.length + 1, item_revision: item.revision,
        started_at: new Date(this.clock()).toISOString(), node_id: this.store.node?.id ?? null, node_name: this.store.node?.name ?? null });
      item.triage.status = "evaluating";
      item.triage.retry_requested_at = null;
      item.triage.next_attempt_at = null;
    });
    try {
      const snapshot = await this.store.read();
      const item = snapshot.items[id];
      const projects = this.config.projects.map((project) => projectContext(project));
      const selectedProject = item.selected_project ?? item.input.project_id;
      const proposed = await this.decision.decide({ item: { ...item, related_work: relatedWork(snapshot, item),
        input: { ...item.input, ...(selectedProject ? { project_id: selectedProject } : {}) } }, projects,
        directory: path.join(this.store.directory, "decisions", id, String(item.revision)), onStart: this.processRecorder("items", id) });
      const configuredProject = this.config.projects.find((project) => project.id === proposed.project);
      const role = configuredProject ? inferAgentRole({ item, decision: proposed, project: configuredProject }) : "general";
      const project = configuredProject ? executionProjectContext(configuredProject, role) : null;
      const decision = project ? inferRoutineAcceptanceCriteria(proposed, project, item, role) : proposed;
      let route = routeDecision(decision, project ? [project] : projects, selectedProject);
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
        current.decision = decision;
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
          current.execution_eligible = route.state === "Ready";
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
      data.jobs[id] = record(id, { state: "Ready", parent_id: item.id, project_id: item.project_id,
        work, agent_role: item.agent_role ?? "general", project_context: item.project_context, policy_hash: item.policy_hash,
        dependencies: [...item.decision.dependencies, ...(index ? [`${item.id}-${index}`] : [])],
        attempts: [], processes: [], priority_rank: priorityRank(item), position: Object.keys(data.jobs).length });
      return id;
    });
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
      const decision = { ...item.decision, safe_to_execute: true, approval_required: false, decision: "execute" };
      const authorized = { ...contextualProject, policy: { ...contextualProject.policy, allow_autonomous: true, approval_required: false } };
      const route = routeDecision(decision, [authorized], item.selected_project ?? item.input.project_id);
      if (route.state !== "Ready") throw new Error(`Approval cannot bypass readiness: ${route.reason}`);
      item.approval = { actor, revision, at: new Date().toISOString() };
      const question = (item.questions ?? []).findLast((candidate) => candidate.status === "open");
      if (question) {
        question.answer = { text: "Approved", actor, at: item.approval.at };
        question.status = "answered";
        question.revision += 1;
        question.updated_at = item.approval.at;
      }
      this.store.move(data, item, "Ready", `Approved by ${actor}.`);
      this.createJobs(data, item);
      data.projects[item.project_id] ??= {};
      return item;
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
  async answerQuestion(id, answer, actor, expectedRevision) {
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
        if (question.status !== "open" || question.revision !== expectedRevision) throw new Error("Answer is stale or this question was already resolved.");
        const importedDecision = item.state === "Imported Pending" && question.kind === "imported_decision" && item.requires_reevaluation;
        if ((!importedDecision && !["Needs Clarification", "Review"].includes(item.state)) || item.job_ids.length) throw new Error("Question cannot be answered in the item's current state.");
        const now = new Date().toISOString();
        question.answer = { text: answer, actor, at: now };
        question.status = "answered";
        question.revision += 1;
        question.updated_at = now;
        item.clarifications.push({ text: answer, actor, question_id: question.id, decision_id: question.decision_id, decision_key: question.decision_key ?? null, at: now });
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
      const machineLocal = isMachineLocal(project);
      if (!machineLocal) {
        releaseRepo = this.shipping.lock(project);
        await this.store.change((data) => { data.projects[project.id].repository_lock = releaseRepo.directory ?? `postgresql:project/${project.id}`; });
      }
      const state = await this.store.read();
      const job = state.jobs[id];
      const currentProjectContext = executionProjectContext(project, job.agent_role ?? "general");
      const currentPolicyHash = digest(currentProjectContext);
      if (currentPolicyHash !== job.policy_hash) {
        if ((job.attempts?.length ?? 0) > 0 || !sameExecutionAuthority(job.project_context, currentProjectContext)) {
          throw new Error("Project policy or context changed after decision; resubmit for a new decision.");
        }
        await this.store.change((data) => {
          const current = data.jobs[id];
          if (!current || current.state !== "Ready" || (current.attempts?.length ?? 0) > 0) {
            throw new Error("Job changed while refreshing project context.");
          }
          current.project_context = currentProjectContext;
          current.policy_hash = currentPolicyHash;
          current.context_refresh = {
            at: new Date().toISOString(),
            reason: "Non-authority project context changed before execution; refreshed against current project state.",
          };
        });
        job.project_context = currentProjectContext;
        job.policy_hash = currentPolicyHash;
      }
      if (!machineLocal && !this.shipping.supports(project)) throw new Error(`Shipping policy ${project.policy.shipping} has no installed provider.`);
      const prepared = machineLocal
        ? { workspace_mode: "machine_local", working_directory: project.herdr.working_directory, machine_selector: project.herdr.machine, agent_target: project.herdr.agent }
        : this.shipping.prepare({ project, job, directory: path.join(this.store.directory, "workspaces"), base: state.projects[project.id]?.last_commit });
      await this.store.change((data) => { data.jobs[id].prepared = prepared; });
      for (let attempt = 0; attempt <= project.policy.max_rework_attempts; attempt++) {
        const current = (await this.store.read()).jobs[id];
        await this.store.change((data) => {
          const j = data.jobs[id];
          this.store.move(data, j, "Executing", `Execution attempt ${attempt + 1}.`);
          j.attempts.push({ number: attempt + 1, started_at: new Date().toISOString(),
            node_id: this.store.node?.id ?? null, node_name: this.store.node?.name ?? null });
        });
        let failure;
        let deliveryAttempted = false;
        try {
          const execution = await this.runtime.execute({ project, job: current, workspace: prepared.workspace,
            directory: path.join(this.store.directory, "executions", id, String(attempt + 1)),
            previous_failure: current.attempts.at(-1) ?? null, onStart: this.processRecorder("jobs", id),
            onRemoteStart: (remote_execution) => this.store.change((data) => {
              data.jobs[id].attempts.at(-1).execution = { passed: null, started_at: new Date().toISOString(), remote_execution };
              if (machineLocal) data.jobs[id].delivery_intent = { mode: "machine_local", working_directory: project.herdr.working_directory,
                machine_selector: project.herdr.machine, agent_target: project.herdr.agent, branch: `codex/roundhouse-${id}`, policy: project.policy.shipping };
            }) });
          await this.store.change((data) => { data.jobs[id].attempts.at(-1).execution = execution; });
          if (!execution.passed) throw new Error(execution.error ?? `Executor failed (exit ${execution.exit_code}).`);
          if (machineLocal) {
            const { verification, shipping } = machineLocalEvidence(project, current, execution);
            await this.store.change((data) => {
              const j = data.jobs[id];
              this.store.move(data, j, "Verification", "Recording remote machine-local verification evidence.");
              j.attempts.at(-1).verification = verification;
              j.shipping = shipping;
              j.processes = [];
              this.store.move(data, j, "Shipped", "Remote agent reported verified machine-local delivery; Roundhouse did not inspect the remote filesystem.");
              data.projects[project.id] = { ...data.projects[project.id], last_commit: shipping.commit,
                active: false, review_required: project.policy.review_after_shipping };
              const parent = data.items[j.parent_id];
              if (parent.job_ids.every((key) => data.jobs[key].state === "Shipped")) parent.completed_at = shipping.timestamp;
            });
            return true;
          }
          const snapshot = this.shipping.snapshot({ project, job: current, prepared });
          await this.store.change((data) => {
            data.jobs[id].attempts.at(-1).snapshot = snapshot;
            this.store.move(data, data.jobs[id], "Verification", "Verifying committed candidate.");
          });
          const verification = await this.verifier.verify({ project, job: current, workspace: prepared.workspace, commit: snapshot.commit, snapshot, execution,
            directory: path.join(this.store.directory, "evidence", id, String(attempt + 1)), onStart: this.processRecorder("jobs", id) });
          if (!this.shipping.unchanged(prepared, snapshot.commit)) {
            verification.passed = false;
            verification.checks.push({ id: "unchanged-tested-version", passed: false, stderr: "Verification modified the tested version or left uncommitted changes." });
          }
          await this.store.change((data) => { data.jobs[id].attempts.at(-1).verification = verification; });
          if (!verification.passed) throw new Error("Required verification failed.");
          // Persist delivery intent before touching a remote. On crash this attempt is never replayed.
          await this.store.change((data) => { data.jobs[id].delivery_intent = { commit: snapshot.commit, branch: prepared.branch, policy: project.policy.shipping }; });
          if (heartbeatError) throw heartbeatError;
          if (this.store.shared) {
            await this.store.assertLease(projectLease);
            if (!jobLease) throw new Error("Shared execution has no authoritative job lease.");
            await this.store.assertLease(jobLease);
          }
          let delivered;
          deliveryAttempted = true;
          try { delivered = await this.shipping.ship({ project, job: current, prepared, verification, onStart: this.processRecorder("jobs", id) }); }
          catch (error) { await this.block(id, `Delivery failed or uncertain: ${error.message}`); return true; }
          await this.store.change((data) => {
            const j = data.jobs[id];
            j.shipping = delivered;
            j.processes = [];
            this.store.move(data, j, "Shipped", "Verified work delivered under project policy.");
            data.projects[project.id] = { ...data.projects[project.id], last_commit: delivered.commit,
              active: false, review_required: project.policy.review_after_shipping };
            const parent = data.items[j.parent_id];
            if (parent.job_ids.every((key) => data.jobs[key].state === "Shipped")) {
              parent.completed_at = delivered.timestamp;
            }
          });
          return true;
        } catch (error) {
          if (machineLocal) { await this.store.change((data) => { data.jobs[id].attempts.at(-1).failure = error.message; });
            await this.block(id, `Machine-local Herdr outcome requires explicit reconciliation and will not be replayed automatically: ${error.message}`); return true; }
          if (deliveryAttempted) { await this.block(id, `Delivery outcome requires reconciliation: ${error.message}`); return true; }
          failure = error.message;
        }
        await this.store.change((data) => { data.jobs[id].attempts.at(-1).failure = failure; });
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
  async refreshJobContext(id, { actor }) {
    if (typeof actor !== "string" || !actor.trim()) throw new Error("Job context refresh requires an actor.");
    const snapshot = await this.store.read();
    const job = snapshot.jobs[id];
    if (!job || job.state !== "Blocked") throw new Error("Only a Blocked job can refresh project context.");
    if ((job.attempts?.length ?? 0) > 0) throw new Error("Started work cannot refresh project context; reconcile or replace it.");
    if (!/Project policy or context changed after decision/.test(job.history?.at(-1)?.reason ?? "")) {
      throw new Error("Job is not blocked by stale project context.");
    }
    const project = this.config.projects.find((candidate) => candidate.id === job.project_id);
    if (!project) throw new Error("Job context refresh requires a configured project.");
    const currentProjectContext = executionProjectContext(project, job.agent_role ?? "general");
    if (!sameExecutionAuthority(job.project_context, currentProjectContext)) {
      throw new Error("Execution authority changed; a new decision is required.");
    }
    const currentPolicyHash = digest(currentProjectContext);
    const at = new Date().toISOString();
    return await this.store.change((data) => {
      const current = data.jobs[id];
      if (!current || current.state !== "Blocked" || (current.attempts?.length ?? 0) > 0) {
        throw new Error("Job changed while refreshing project context.");
      }
      current.project_context = currentProjectContext;
      current.policy_hash = currentPolicyHash;
      current.context_refresh = {
        at,
        actor: actor.trim(),
        reason: "Operator refreshed non-authority project context after verified upstream work.",
      };
      this.store.move(data, current, "Ready", "Non-authority project context refreshed by " + actor.trim() + "; execution authority is unchanged.");
      data.projects[current.project_id] = { ...data.projects[current.project_id], blocked: false, active: false };
      return current;
    });
  }

  async reconcileJob(id, { actor, note, commit, branch }) {
    for (const [name, value] of Object.entries({ actor, note, commit, branch })) {
      if (typeof value !== "string" || !value.trim()) throw new Error(`Job reconciliation requires ${name}.`);
    }
    const snapshot = await this.store.read();
    const job = snapshot.jobs[id];
    if (!job || job.state !== "Blocked") throw new Error("Only a Blocked job can be reconciled.");
    const project = this.config.projects.find((candidate) => candidate.id === job.project_id);
    if (!project) throw new Error("Job reconciliation requires a configured project.");
    const expectedBranch = job.prepared?.branch ?? `codex/roundhouse-${job.id}`;
    if (branch !== expectedBranch) throw new Error(`Reconciliation branch must be ${expectedBranch}.`);
    if (isMachineLocal(project)) {
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) throw new Error("Machine-local reconciliation requires a full lowercase Git commit SHA.");
      const at = new Date().toISOString();
      return await this.store.change((data) => {
        const current = data.jobs[id];
        if (!current || current.state !== "Blocked") throw new Error("Job changed while reconciliation was being recorded.");
        const verification = { commit, at, passed: true, independently_verified: false,
          checks: [{ id: "operator-remote-reconciliation", source: "operator", passed: true, summary: note.trim() }] };
        current.reconciliation = { status: "completed", actor: actor.trim(), note: note.trim(), commit, branch, verified_at: at,
          workspace_mode: "machine_local", working_directory: project.herdr.working_directory, independently_verified: false };
        const attempt = current.attempts?.at(-1);
        if (attempt) attempt.reconciliation = current.reconciliation;
        current.shipping = { repository: null, working_directory: project.herdr.working_directory, branch, commit,
          policy: project.policy.shipping, remote: project.policy.shipping === "push_branch" ? project.remote : null, pr_url: null,
          deployment: null, verification, timestamp: at, pushed: project.policy.shipping === "push_branch", source: "operator_remote_attestation" };
        current.processes = [];
        this.store.move(data, current, "Shipped", `Operator reconciled machine-local delivery by explicit remote attestation: ${note.trim()}`);
        data.projects[current.project_id] = { ...data.projects[current.project_id], last_commit: commit, blocked: false, active: false,
          resume_approval: { actor: actor.trim(), note: note.trim(), at } };
        const parent = data.items[current.parent_id];
        if (parent?.job_ids?.every((key) => data.jobs[key]?.state === "Shipped")) parent.completed_at = at;
        return current;
      });
    }
    if (!project.repository) throw new Error("Job reconciliation requires a configured project repository.");
    const resolvedCommit = git(project.repository, ["rev-parse", "--verify", `${commit}^{commit}`]);
    if (resolvedCommit !== commit) throw new Error("Reconciliation requires the full exact commit SHA.");
    const branchCommit = git(project.repository, ["rev-parse", "--verify", `${branch}^{commit}`]);
    if (branchCommit !== resolvedCommit) throw new Error("Reconciliation branch does not resolve to the supplied commit.");
    const preparedBase = job.prepared?.base ?? null;
    if (preparedBase) git(project.repository, ["merge-base", "--is-ancestor", preparedBase, resolvedCommit]);
    for (const dependencyId of job.dependencies ?? []) {
      const dependencyCommit = snapshot.jobs[dependencyId]?.shipping?.commit ?? null;
      if (dependencyCommit) git(project.repository, ["merge-base", "--is-ancestor", dependencyCommit, resolvedCommit]);
    }
    let remote = null;
    let pushed = false;
    if (project.policy.shipping === "push_branch" || (project.policy.shipping === "deploy" && project.deployment?.push_branch)) {
      remote = git(project.repository, ["remote", "get-url", "--push", project.remote]);
      const confirmed = git(project.repository, ["ls-remote", project.remote, `refs/heads/${branch}`]);
      if (confirmed.split(/\s+/)[0] !== resolvedCommit) throw new Error("Remote branch does not match the supplied commit.");
      pushed = true;
    }
    const at = new Date().toISOString();
    return await this.store.change((data) => {
      const current = data.jobs[id];
      if (!current || current.state !== "Blocked") throw new Error("Job changed while reconciliation was being verified.");
      const verification = { commit: resolvedCommit, at, passed: true, checks: [{ id: "operator-reconciliation", source: "operator", passed: true, summary: note.trim() }] };
      current.reconciliation = { status: "completed", actor: actor.trim(), note: note.trim(), commit: resolvedCommit, branch, verified_at: at };
      const attempt = current.attempts?.at(-1);
      if (attempt) attempt.reconciliation = current.reconciliation;
      current.shipping = { repository: project.repository, branch, commit: resolvedCommit, policy: project.policy.shipping, remote, pr_url: null, deployment: null, verification, timestamp: at, pushed };
      current.processes = [];
      this.store.move(data, current, "Shipped", `Operator reconciled retained delivery: ${note.trim()}`);
      data.projects[current.project_id] = { ...data.projects[current.project_id], last_commit: resolvedCommit, blocked: false, active: false,
        resume_approval: { actor: actor.trim(), note: note.trim(), at } };
      const parent = data.items[current.parent_id];
      if (parent?.job_ids?.every((key) => data.jobs[key]?.state === "Shipped")) parent.completed_at = at;
      return current;
    });
  }
  block(id, reason) {
    return this.store.change((data) => {
      const job = data.jobs[id];
      this.store.move(data, job, "Blocked", reason);
      data.projects[job.project_id] = { ...data.projects[job.project_id], blocked: true, active: false };
    });
  }
  async explodeJob(id, { expectedRevision, actor, note = "Operator removed a blocked job." } = {}) {
    if (typeof id !== "string" || !id.trim()) throw new Error("A blocked job ID is required.");
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Current job revision is required.");
    if (typeof actor !== "string" || !actor.trim() || actor.length > 128) throw new Error("Job removal requires an actor.");
    if (typeof note !== "string" || !note.trim() || note.length > 2_000) throw new Error("Job removal requires a concise audit note.");
    const release = this.store.shared ? () => {} : this.store.acquireWorkerLease();
    try {
      return await this.store.change((data) => {
        const job = data.jobs[id];
        const removeRecoveryItems = () => {
          const removed = [];
          for (const [itemId, candidate] of Object.entries(data.items)) {
            const originalId = candidate.blocker_followup?.original_id ?? candidate.input?.context?.blocker_entity_id;
            if (originalId !== id) continue;
            removed.push(itemId);
            delete data.items[itemId];
          }
          return removed;
        };
        if (!job) {
          const explosion = data.system_metadata?.job_explosions?.findLast((entry) => entry.id === id);
          if (!explosion) throw new Error("Blocked job was not found.");
          if (explosion.prior_revision !== expectedRevision) throw new Error("Stale job revision; review the latest blocker before removing it.");
          const removedRecoveryItems = removeRecoveryItems();
          explosion.removed_recovery_items = [...new Set([...(explosion.removed_recovery_items ?? []), ...removedRecoveryItems])];
          return { removed: true, already_removed: true, id, project_id: explosion.project_id, parent_id: explosion.parent_id,
            released_jobs: explosion.released_jobs ?? [], removed_recovery_items: removedRecoveryItems, at: explosion.at };
        }
        if (job.state !== "Blocked") throw new Error("Only a Blocked job can be removed from the queue.");
        if (job.revision !== expectedRevision) throw new Error("Stale job revision; review the latest blocker before removing it.");
        if ((job.processes ?? []).some(({ pid }) => processIsAlive(pid)) || job.owning_node_id || data.projects?.[job.project_id]?.active) {
          throw new Error("Job removal refused while project execution may still be active.");
        }
        const at = new Date(this.clock()).toISOString();
        const releasedJobs = [];
        const removedRecoveryItems = [];
        for (const candidate of Object.values(data.jobs)) {
          if (candidate.id === id || !(candidate.dependencies ?? []).includes(id)) continue;
          candidate.dependencies = candidate.dependencies.filter((dependency) => dependency !== id);
          candidate.revision += 1;
          candidate.updated_at = at;
          candidate.history.push({ from: candidate.state, to: candidate.state,
            reason: `Blocked prerequisite ${id} was removed by ${actor.trim()}; remaining dependencies are preserved.`, at });
          releasedJobs.push(candidate.id);
        }
        removedRecoveryItems.push(...removeRecoveryItems());
        const parent = data.items[job.parent_id];
        if (parent) {
          parent.job_ids = (parent.job_ids ?? []).filter((jobId) => jobId !== id);
          parent.revision += 1;
          parent.updated_at = at;
          parent.history.push({ from: parent.state, to: parent.state,
            reason: `Blocked job ${id} was removed by ${actor.trim()}.`, at });
        }
        data.system_metadata ??= {};
        data.system_metadata.job_explosions ??= [];
        data.system_metadata.job_explosions.push({ id, parent_id: job.parent_id ?? null, project_id: job.project_id ?? null,
          title: job.work?.title ?? id, prior_revision: job.revision, actor: actor.trim(), note: note.trim(), at,
          released_jobs: releasedJobs, removed_recovery_items: removedRecoveryItems });
        if (data.system_metadata.job_explosions.length > 500) data.system_metadata.job_explosions.splice(0, data.system_metadata.job_explosions.length - 500);
        delete data.jobs[id];
        const project = data.projects[job.project_id] ?? {};
        data.projects[job.project_id] = { ...project, blocked: false, active: false,
          resume_approval: { actor: actor.trim(), note: `Removed blocker ${id}: ${note.trim()}`, at } };
        return { removed: true, id, project_id: job.project_id, parent_id: job.parent_id, released_jobs: releasedJobs,
          removed_recovery_items: removedRecoveryItems, at };
      });
    } finally { release(); }
  }
  async runUnblocker() {
    return new Unblocker({ store: this.store, config: this.config, engine: this }).run();
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
      await this.store.change((data) => schedulerState(data, this.config.execution.capacity));
      const stopped = new Set();
      while (executed < this.config.max_jobs_per_run) {
        const state = await this.store.read();
        const candidates = this.config.projects.filter((p) => (!projectId || p.id === projectId) && p.status === "active" && !stopped.has(p.id) && !state.projects[p.id]?.blocked && !state.projects[p.id]?.stop && !state.projects[p.id]?.review_required
          && projectExecutionEligible(p, this.config.execution)
          && (isMachineLocal(p) || (this.shipping.canDispatch?.(p) ?? true))
          && Object.values(state.jobs).filter((job) => job.project_id === p.id && ["Executing", "Verification", "Rework"].includes(job.state)).length < p.max_concurrent_runs);
        // Weighted turns across projects; each project's own order is preserved.
        const scheduler = state.system_metadata.execution_scheduler;
        candidates.sort((a, b) => weightedAllocation(scheduler, a) - weightedAllocation(scheduler, b) || a.id.localeCompare(b.id));
        let selected;
        for (const project of candidates) {
          const job = Object.values(state.jobs).filter((j) => j.project_id === project.id && j.state === "Ready" && j.dependencies.every((id) => state.jobs[id]?.state === "Shipped"))
            .sort((a, b) => priorityRank(a) - priorityRank(b) || a.position - b.position)[0];
          if (job) { selected = { project, job }; break; }
        }
        if (!selected) break;
        const { project, job } = selected;
        await this.store.change((data) => {
          data.projects[project.id] = { ...data.projects[project.id], active: true };
          recordAllocation(data, project, this.config.execution.capacity, new Date(this.clock()).toISOString());
          data.jobs[job.id].owning_node_id = this.store.node?.id ?? null;
          data.jobs[job.id].owning_node = this.store.node?.name ?? null;
        });
        await this.execute(job.id, project);
        await this.store.change((data) => {
          data.jobs[job.id].owning_node_id = null;
          data.jobs[job.id].owning_node = null;
        });
        executed++;
        if (project.policy.continuation === "stop_after_job") stopped.add(project.id);
      }
      return { executed, limit_reached: executed >= this.config.max_jobs_per_run, ...await this.store.read() };
    } finally { release(); }
  }

  async runSharedDispatch({ projectId } = {}) {
    let executed = 0;
    if (projectId && !this.config.projects.some((project) => project.id === projectId)) throw new Error("Unknown project filter.");
    await this.store.heartbeatNode("online");
    await this.store.recoverExpiredClaims();
    await this.store.change((data) => schedulerState(data, this.config.execution.capacity));

    let snapshot;
    const stopped = new Set();
    while (executed < this.config.max_jobs_per_run) {
      snapshot = await this.store.read();
      if (hasImportedTriageBarrier(snapshot)) break;
      const candidates = this.config.projects.filter((project) => (!projectId || project.id === projectId)
        && project.status === "active" && !stopped.has(project.id) && !snapshot.projects[project.id]?.blocked
        && !snapshot.projects[project.id]?.stop && !snapshot.projects[project.id]?.review_required
        && (isMachineLocal(project) || (this.shipping.canDispatch?.(project) ?? true))
        && projectExecutionEligible(project, this.config.execution)
        && (isMachineLocal(project) || (this.shipping.canDispatch?.(project) ?? true))
        && Object.values(snapshot.jobs).filter((job) => job.project_id === project.id && ["Executing", "Verification", "Rework"].includes(job.state)).length < project.max_concurrent_runs);
      const scheduler = snapshot.system_metadata.execution_scheduler;
      candidates.sort((a, b) => weightedAllocation(scheduler, a) - weightedAllocation(scheduler, b) || a.id.localeCompare(b.id));
      if (!candidates.length) break;
      const claim = await this.store.claimJob(candidates.map((project) => project.id));
      if (!claim) break;
      const project = candidates.find((candidate) => candidate.id === claim.job.project_id);
      try {
        await this.store.change((data) => {
          data.projects[project.id] = { ...data.projects[project.id], active: true };
          recordAllocation(data, project, this.config.execution.capacity, new Date(this.clock()).toISOString());
        });
        const didExecute = await this.execute(claim.job.id, project, claim.lease);
        if (!didExecute) break;
        executed += 1;
        if (project.policy.continuation === "stop_after_job") stopped.add(project.id);
      } finally {
        await this.store.releaseLease(claim.lease).catch(() => {});
      }
    }
    return { executed, limit_reached: executed >= this.config.max_jobs_per_run, ...await this.store.read() };
  }
}
