import path from "node:path";
import { acquireLock, digest } from "./store.js";
import { record } from "./state.js";
import { projectContext } from "./config.js";
import { computeAdvisory, DecisionProvider, hasExecutableAcceptanceCriteria, routeDecision } from "./decision.js";
import { LocalRuntime, CommandVerifier } from "./runtime.js";
import { GitDelivery } from "./delivery.js";

export class Engine {
  constructor({ store, config, decision = new DecisionProvider(config.decision), runtime = new LocalRuntime(), verifier = new CommandVerifier(), shipping = new GitDelivery() }) {
    Object.assign(this, { store, config, decision, runtime, verifier, shipping });
  }
  processRecorder(collection, id) {
    return (pid) => this.store.change((data) => {
      const entity = data[collection][id];
      entity.processes ??= [];
      entity.processes.push({ pid, at: new Date().toISOString() });
    });
  }
  async decide(id) {
    this.store.change((data) => {
      const item = data.items[id];
      if (item.state === "Decision" && item.awaiting_decision) item.awaiting_decision = false;
      else {
        if (!["Depot", "Needs Clarification"].includes(item.state)) throw new Error("Item cannot be decided in its current state.");
        this.store.move(data, item, "Decision", "Evaluating Depot request.");
      }
    });
    try {
      const item = this.store.read().items[id];
      const projects = this.config.projects.map(projectContext);
      const selectedProject = item.selected_project ?? item.input.project_id;
      const decision = await this.decision.decide({ item: { ...item, input: { ...item.input, ...(selectedProject ? { project_id: selectedProject } : {}) } }, projects, directory: path.join(this.store.directory, "decisions", id, String(item.revision)), onStart: this.processRecorder("items", id) });
      const route = routeDecision(decision, projects, selectedProject);
      const project = projects.find((p) => p.id === decision.project);
      this.store.change((data) => {
        const current = data.items[id];
        current.decision_history ??= [];
        if (current.decision) current.decision_history.push(current.decision);
        current.decision = decision;
        current.project_id = project?.id ?? null;
        current.goal_id ??= current.input.goal_id ?? null;
        current.policy_hash = project ? digest(project) : null;
        current.project_context = project ?? null;
        current.compute_advisory = project ? computeAdvisory(project) : null;
        current.processes = [];
        current.refinement ??= { active_question: null, answers: [] };
        if (decision.dependencies.some((dependency) => !data.jobs[dependency])) {
          const question = "Which existing work items should this request depend on?";
          this.store.move(data, current, "Needs Clarification", question);
          current.refinement.active_question = {
            id: `${current.id}:decision:${current.revision}`, prompt: question,
            kind: "dependencies", revision: current.revision,
          };
        } else {
          this.store.move(data, current, route.state, route.reason);
          current.refinement.active_question = route.state === "Needs Clarification" ? {
            id: `${current.id}:decision:${current.revision}`,
            prompt: route.question || route.reason,
            kind: route.refinement ?? "scope",
            revision: current.revision,
          } : null;
          if (route.state === "Ready") this.createJobs(data, current);
        }
      });
    } catch (error) {
      this.store.change((data) => this.store.move(data, data.items[id], "Blocked", `Decision failed: ${error.message}`));
    }
  }
  createJobs(data, item) {
    item.job_ids = item.decision.work_items.map((work, index) => {
      const id = `${item.id}-${index + 1}`;
      if (data.jobs[id]) throw new Error("Work already exists for this decision.");
      data.jobs[id] = record(id, { state: "Ready", parent_id: item.id, project_id: item.project_id, goal_id: item.goal_id ?? null,
        work, project_context: item.project_context, policy_hash: item.policy_hash,
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
      if (!project || digest(projectContext(project)) !== item.policy_hash) throw new Error("Project context/policy changed. Clarify and re-decide first.");
      // Human approval resolves authority, not missing verification or confidence.
      const decision = { ...item.decision, safe_to_execute: true, approval_required: false, decision: "execute" };
      const authorized = { ...project, policy: { ...project.policy, allow_autonomous: true, approval_required: false } };
      const route = routeDecision(decision, [authorized], item.selected_project ?? item.input.project_id);
      if (route.state !== "Ready") throw new Error(`Approval cannot bypass readiness: ${route.reason}`);
      item.approval = { actor, revision, at: new Date().toISOString() };
      this.store.move(data, item, "Ready", `Approved by ${actor}.`);
      this.createJobs(data, item);
      data.projects[item.project_id] ??= {};
      return item;
    });
  }
  clarify(id, text, actor, projectId, questionId) {
    if (!text?.trim() || !actor?.trim()) throw new Error("Clarification needs text and actor.");
    return this.store.change((data) => {
      const item = data.items[id];
      if (!item || !["Needs Clarification", "Review"].includes(item.state) || item.job_ids.length) throw new Error("Item cannot be clarified here.");
      // Lazily adapt state written before structured refinement questions existed.
      const active = item.refinement?.active_question ?? {
        id: item.state === "Needs Clarification" ? `${item.id}:decision:${item.revision}` : `${item.id}:decision`,
        prompt: item.decision?.question || item.history.at(-1)?.reason || "What detail is needed before continuing?",
        kind: item.state === "Review" ? "review" : "scope", revision: item.revision,
      };
      if (questionId && questionId !== active?.id) throw new Error("Clarification must answer the current refinement question.");
      if (projectId) {
        if (!this.config.projects.some((p) => p.id === projectId)) throw new Error("Unknown project.");
        // Original input remains immutable; the provider receives this explicit correction.
        item.selected_project = projectId;
      }
      const answer = { question_id: active?.id ?? null, question: active?.prompt ?? null, text, actor, project_id: projectId ?? null, at: new Date().toISOString() };
      item.clarifications.push(answer);
      item.refinement ??= { active_question: null, answers: [] };
      item.refinement.answers ??= [];
      item.refinement.answers.push(answer);
      item.refinement.active_question = null;
      this.store.move(data, item, "Decision", "Human clarification received.");
      // Re-entered by the next run without automatically repeating an interrupted decision.
      item.awaiting_decision = true;
      return item;
    });
  }
  async execute(id, project) {
    let releaseRepo;
    try {
      const state = this.store.read();
      const job = state.jobs[id];
      if (!hasExecutableAcceptanceCriteria(job?.work, project)) throw new Error("Execution requires acceptance criteria mapped to configured verification checks.");
      releaseRepo = this.shipping.lock(project);
      this.store.change((data) => { data.projects[project.id].repository_lock = releaseRepo.directory ?? null; });
      if (digest(projectContext(project)) !== job.policy_hash) throw new Error("Project policy or context changed after decision; resubmit for a new decision.");
      if (!this.shipping.supports(project.policy.shipping)) throw new Error(`Shipping policy ${project.policy.shipping} has no installed provider.`);
      const prepared = this.shipping.prepare({ project, job, directory: path.join(this.store.directory, "workspaces"), base: state.projects[project.id]?.last_commit });
      this.store.change((data) => { data.jobs[id].prepared = prepared; });
      for (let attempt = 0; attempt <= project.policy.max_rework_attempts; attempt++) {
        const current = this.store.read().jobs[id];
        this.store.change((data) => {
          const j = data.jobs[id];
          this.store.move(data, j, "Executing", `Execution attempt ${attempt + 1}.`);
          j.attempts.push({ number: attempt + 1, started_at: new Date().toISOString() });
        });
        let failure;
        let deliveryAttempted = false;
        try {
          const execution = await this.runtime.execute({ project, job: current, workspace: prepared.workspace,
            previous_failure: current.attempts.at(-1) ?? null, onStart: this.processRecorder("jobs", id) });
          this.store.change((data) => { data.jobs[id].attempts.at(-1).execution = execution; });
          if (!execution.passed) throw new Error(`Executor failed (exit ${execution.exit_code}).`);
          const snapshot = this.shipping.snapshot({ project, job: current, prepared });
          this.store.change((data) => {
            data.jobs[id].attempts.at(-1).snapshot = snapshot;
            this.store.move(data, data.jobs[id], "Verification", "Verifying committed candidate.");
          });
          const verification = await this.verifier.verify({ project, job: current, workspace: prepared.workspace, commit: snapshot.commit, onStart: this.processRecorder("jobs", id) });
          if (!this.shipping.unchanged(prepared, snapshot.commit)) {
            verification.passed = false;
            verification.checks.push({ id: "unchanged-tested-version", passed: false, stderr: "Verification modified the tested version or left uncommitted changes." });
          }
          this.store.change((data) => { data.jobs[id].attempts.at(-1).verification = verification; });
          if (!verification.passed) throw new Error("Required verification failed.");
          // Persist delivery intent before touching a remote. On crash this attempt is never replayed.
          this.store.change((data) => { data.jobs[id].delivery_intent = { commit: snapshot.commit, branch: prepared.branch, policy: project.policy.shipping }; });
          let delivered;
          deliveryAttempted = true;
          try { delivered = await this.shipping.ship({ project, job: current, prepared, verification, onStart: this.processRecorder("jobs", id) }); }
          catch (error) { this.block(id, `Delivery failed or uncertain: ${error.message}`); return; }
          this.store.change((data) => {
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
          return;
        } catch (error) {
          if (deliveryAttempted) { this.block(id, `Delivery outcome requires reconciliation: ${error.message}`); return; }
          failure = error.message;
        }
        this.store.change((data) => { data.jobs[id].attempts.at(-1).failure = failure; });
        if (attempt === project.policy.max_rework_attempts) { this.block(id, `Rework limit reached: ${failure}`); return; }
        if (this.store.read().projects[project.id]?.stop) { this.block(id, "Operator stopped the project before automated rework."); return; }
        this.store.change((data) => this.store.move(data, data.jobs[id], "Rework", failure));
      }
    } catch (error) { this.block(id, error.message); }
    finally {
      if (releaseRepo) {
        releaseRepo();
        this.store.change((data) => { data.projects[project.id].repository_lock = null; });
      }
    }
  }
  block(id, reason) {
    this.store.change((data) => {
      const job = data.jobs[id];
      this.store.move(data, job, "Blocked", reason);
      data.projects[job.project_id] = { ...data.projects[job.project_id], blocked: true, active: false };
    });
  }
  async run({ projectId, dispatchOnly = false, jobId = null, maxJobs = this.config.max_jobs_per_run } = {}) {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > this.config.max_jobs_per_run) throw new Error("Invalid dispatch job limit.");
    if (jobId && (!dispatchOnly || typeof jobId !== "string")) throw new Error("A specific job requires dispatch-only mode.");
    const release = acquireLock(this.store.workerLock);
    let executed = 0;
    try {
      if (projectId && !this.config.projects.some((p) => p.id === projectId)) throw new Error("Unknown project filter.");
      const snapshot = this.store.read();
      if ([...Object.values(snapshot.items), ...Object.values(snapshot.jobs)].some((j) => ["Executing", "Verification", "Rework"].includes(j.state) || (j.state === "Decision" && !j.awaiting_decision))) throw new Error("Interrupted work requires recovery, not automatic replay.");
      for (const item of dispatchOnly ? [] : Object.values(snapshot.items)) {
        if (item.state !== "Depot" && !item.awaiting_decision) continue;
        if (projectId && item.input.project_id && item.input.project_id !== projectId) continue;
        await this.decide(item.id);
      }
      const stopped = new Set();
      while (executed < maxJobs) {
        const state = this.store.read();
        const candidates = this.config.projects.filter((p) => (!projectId || p.id === projectId) && p.status === "active" && p.runtime === "local" && !stopped.has(p.id) && !state.projects[p.id]?.blocked && !state.projects[p.id]?.stop && !state.projects[p.id]?.review_required && !Object.values(state.items).some((i) => i.project_id === p.id && i.state === "Review"));
        // Weighted turns across projects; each project's own order is preserved.
        candidates.sort((a, b) => ((state.projects[a.id]?.turns ?? 0) / a.weight) - ((state.projects[b.id]?.turns ?? 0) / b.weight) || a.id.localeCompare(b.id));
        let selected;
        for (const project of candidates) {
          const job = Object.values(state.jobs).filter((j) => j.project_id === project.id && j.state === "Ready" &&
            (!jobId || j.id === jobId) && j.dependencies.every((id) => state.jobs[id]?.state === "Shipped") &&
            (!dispatchOnly || (hasExecutableAcceptanceCriteria(j.work, project) &&
              digest(projectContext(project)) === j.policy_hash)))
            .sort((a, b) => a.position - b.position)[0];
          if (job) { selected = { project, job }; break; }
        }
        if (!selected) break;
        const { project, job } = selected;
        this.store.change((data) => {
          data.projects[project.id] = { ...data.projects[project.id], active: true, turns: (data.projects[project.id]?.turns ?? 0) + 1 };
        });
        await this.execute(job.id, project);
        executed++;
        if (project.policy.continuation === "stop_after_job") stopped.add(project.id);
      }
      return { executed, limit_reached: executed >= maxJobs, ...this.store.read() };
    } finally { release(); }
  }
}
