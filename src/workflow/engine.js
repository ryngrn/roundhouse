import path from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../storage/repository.js";
import { record } from "./state.js";
import { projectContext } from "./config.js";
import { DecisionProvider, inferRoutineAcceptanceCriteria, routeDecision } from "./decision.js";
import { LocalRuntime, CommandVerifier } from "./runtime.js";
import { GitDelivery } from "./delivery.js";
import { composeAgentRole, inferAgentRole } from "./roles.js";
import { RoundhouseError } from "../errors.js";

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

const itemPriority = (item) => Number.isFinite(item.priority_rank) ? item.priority_rank : 100;

export class Engine {
  constructor({ store, config, decision = new DecisionProvider(config.decision), runtime = new LocalRuntime(), verifier = new CommandVerifier(), shipping = new GitDelivery() }) {
    Object.assign(this, { store, config, decision, runtime, verifier, shipping });
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
        if (!["Depot", "Needs Clarification"].includes(item.state)) throw new Error("Item cannot be decided in its current state.");
        this.store.move(data, item, "Decision", "Evaluating Depot request.");
      }
    });
    try {
      const item = (await this.store.read()).items[id];
      const projects = this.config.projects.map((project) => projectContext(project));
      const selectedProject = item.selected_project ?? item.input.project_id;
      const proposed = await this.decision.decide({ item: { ...item, input: { ...item.input, ...(selectedProject ? { project_id: selectedProject } : {}) } }, projects, directory: path.join(this.store.directory, "decisions", id, String(item.revision)), onStart: this.processRecorder("items", id) });
      const configuredProject = this.config.projects.find((project) => project.id === proposed.project);
      const role = configuredProject ? inferAgentRole({ item, decision: proposed, project: configuredProject }) : "general";
      const project = configuredProject ? executionProjectContext(configuredProject, role) : null;
      const decision = project ? inferRoutineAcceptanceCriteria(proposed, project, item, role) : proposed;
      const route = routeDecision(decision, project ? [project] : projects, selectedProject);
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
        if (decision.dependencies.some((dependency) => !data.jobs[dependency])) {
          this.store.move(data, current, "Needs Clarification", "Decision referenced unknown dependencies.");
        } else {
          this.store.move(data, current, route.state, route.reason);
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
      });
    } catch (error) {
      if (this.store.shared) await this.store.assertLease(decisionLease);
      await this.store.change((data) => this.store.move(data, data.items[id], "Blocked", `Decision failed: ${error.message}`));
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
        attempts: [], processes: [], position: Object.keys(data.jobs).length });
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
      releaseRepo = this.shipping.lock(project);
      await this.store.change((data) => { data.projects[project.id].repository_lock = releaseRepo.directory ?? `postgresql:project/${project.id}`; });
      const state = await this.store.read();
      const job = state.jobs[id];
      if (digest(executionProjectContext(project, job.agent_role ?? "general")) !== job.policy_hash) throw new Error("Project policy or context changed after decision; resubmit for a new decision.");
      if (!this.shipping.supports(project)) throw new Error(`Shipping policy ${project.policy.shipping} has no installed provider.`);
      const prepared = this.shipping.prepare({ project, job, directory: path.join(this.store.directory, "workspaces"), base: state.projects[project.id]?.last_commit });
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
            previous_failure: current.attempts.at(-1) ?? null, onStart: this.processRecorder("jobs", id) });
          await this.store.change((data) => { data.jobs[id].attempts.at(-1).execution = execution; });
          if (!execution.passed) throw new Error(`Executor failed (exit ${execution.exit_code}).`);
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
  block(id, reason) {
    return this.store.change((data) => {
      const job = data.jobs[id];
      this.store.move(data, job, "Blocked", reason);
      data.projects[job.project_id] = { ...data.projects[job.project_id], blocked: true, active: false };
    });
  }
  async run({ projectId } = {}) {
    if (this.store.shared) return this.runShared({ projectId });
    const release = this.store.acquireWorkerLease();
    let executed = 0;
    try {
      if (projectId && !this.config.projects.some((p) => p.id === projectId)) throw new Error("Unknown project filter.");
      const snapshot = await this.store.read();
      if ([...Object.values(snapshot.items), ...Object.values(snapshot.jobs)].some((j) => ["Executing", "Verification", "Rework"].includes(j.state) || (j.state === "Decision" && !j.awaiting_decision))) throw new Error("Interrupted work requires recovery, not automatic replay.");
      const decisionCandidates = Object.values(snapshot.items)
        .filter((item) => item.state === "Depot" || item.awaiting_decision)
        .sort((a, b) => itemPriority(a) - itemPriority(b) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
      for (const item of decisionCandidates) {
        if (projectId && item.input.project_id && item.input.project_id !== projectId) continue;
        await this.decide(item.id);
      }
      const stopped = new Set();
      while (executed < this.config.max_jobs_per_run) {
        const state = await this.store.read();
        const candidates = this.config.projects.filter((p) => (!projectId || p.id === projectId) && p.status === "active" && !stopped.has(p.id) && !state.projects[p.id]?.blocked && !state.projects[p.id]?.stop && !state.projects[p.id]?.review_required && !Object.values(state.items).some((i) => i.project_id === p.id && i.state === "Review"));
        // Weighted turns across projects; each project's own order is preserved.
        candidates.sort((a, b) => ((state.projects[a.id]?.turns ?? 0) / a.weight) - ((state.projects[b.id]?.turns ?? 0) / b.weight) || a.id.localeCompare(b.id));
        let selected;
        for (const project of candidates) {
          const job = Object.values(state.jobs).filter((j) => j.project_id === project.id && j.state === "Ready" && j.dependencies.every((id) => state.jobs[id]?.state === "Shipped")).sort((a, b) => a.position - b.position)[0];
          if (job) { selected = { project, job }; break; }
        }
        if (!selected) break;
        const { project, job } = selected;
        await this.store.change((data) => {
          data.projects[project.id] = { ...data.projects[project.id], active: true, turns: (data.projects[project.id]?.turns ?? 0) + 1 };
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

  async runShared({ projectId } = {}) {
    let executed = 0;
    if (projectId && !this.config.projects.some((project) => project.id === projectId)) throw new Error("Unknown project filter.");
    await this.store.heartbeatNode("online");
    await this.store.recoverExpiredClaims();

    let snapshot = await this.store.read();
    const decisionCandidates = Object.values(snapshot.items)
      .filter((item) => item.state === "Depot" || item.awaiting_decision)
      .sort((a, b) => itemPriority(a) - itemPriority(b) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
    for (const item of decisionCandidates) {
      if (projectId && item.input.project_id && item.input.project_id !== projectId) continue;
      const lease = await this.store.acquireLease("item", item.id, { operation: "decision" });
      if (!lease) continue;
      try {
        const current = (await this.store.read()).items[item.id];
        if (current && (current.state === "Depot" || current.awaiting_decision)) await this.decide(item.id, lease);
      } finally {
        await this.store.releaseLease(lease).catch(() => {});
      }
    }

    const stopped = new Set();
    while (executed < this.config.max_jobs_per_run) {
      snapshot = await this.store.read();
      const candidates = this.config.projects.filter((project) => (!projectId || project.id === projectId)
        && project.status === "active" && !stopped.has(project.id) && !snapshot.projects[project.id]?.blocked
        && !snapshot.projects[project.id]?.stop && !snapshot.projects[project.id]?.review_required
        && !Object.values(snapshot.items).some((item) => item.project_id === project.id && item.state === "Review"));
      candidates.sort((a, b) => ((snapshot.projects[a.id]?.turns ?? 0) / a.weight) - ((snapshot.projects[b.id]?.turns ?? 0) / b.weight) || a.id.localeCompare(b.id));
      if (!candidates.length) break;
      const claim = await this.store.claimJob(candidates.map((project) => project.id));
      if (!claim) break;
      const project = candidates.find((candidate) => candidate.id === claim.job.project_id);
      try {
        await this.store.change((data) => {
          data.projects[project.id] = { ...data.projects[project.id], active: true, turns: (data.projects[project.id]?.turns ?? 0) + 1 };
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
