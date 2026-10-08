import { randomUUID } from "node:crypto";
import { Engine } from "./engine.js";
import { Store } from "./store.js";
import { loadWorkflowConfig, readWorkflowConfig, saveWorkflowConfig } from "./config.js";
import { normalizeDepotIntake, submitToDepot } from "./intake-contract.js";
import { dashboardProjection, itemView, needsHumanView, notificationView, statusView } from "./views.js";
import { mapResult } from "../storage/repository.js";
import { migrateLegacyDecisionQuestions } from "./legacy-decisions.js";
import { promoteProjectCandidates, projectSlug } from "./project-model.js";

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const jsonSize = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function validateFilters(filters) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new Error("Filters must be an object.");
  for (const key of Object.keys(filters)) if (!["item_id", "project_id"].includes(key)) throw new Error(`Unknown filter: ${key}`);
  for (const key of ["item_id", "project_id"]) if (filters[key] !== undefined && !nonempty(filters[key])) throw new Error(`${key} must be nonempty.`);
  return filters;
}

function projectInitiationValue(value, field, { required = false, limit = 10_000 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`Project initiation requires ${field}.`);
    return null;
  }
  if (!nonempty(value)) throw new Error(`${field} must be nonempty text.`);
  const normalized = value.trim();
  if (normalized.length > limit) throw new Error(`${field} exceeds ${limit.toLocaleString()} characters.`);
  return normalized;
}

function inferredProjectName(outcome) {
  const firstLine = outcome.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "New project";
  const withoutLead = firstLine.replace(/^(build|create|make|launch|start|develop)\s+/i, "");
  const candidate = withoutLead.split(/[.!?]/, 1)[0].trim().replace(/\s+/g, " ");
  return (candidate || "New project").slice(0, 80);
}

export function normalizeIntake(input, adapter = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Intake must be an object.");
  if (!nonempty(input.content)) throw new Error("Intake requires nonempty content.");
  if (input.content.length > 100_000) throw new Error("Intake content exceeds 100,000 characters.");
  if (input.project_hint !== undefined && (!nonempty(input.project_hint) || input.project_hint.length > 500)) throw new Error("project_hint must be a nonempty string of at most 500 characters.");
  if (input.context !== undefined && !(typeof input.context === "string" || (input.context && typeof input.context === "object" && !Array.isArray(input.context)))) throw new Error("context must be text or an object.");
  if (input.context !== undefined && jsonSize(input.context) > 100_000) throw new Error("context exceeds 100,000 encoded bytes.");
  if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 20)) throw new Error("attachments must be an array of at most 20 references.");
  for (const attachment of input.attachments ?? []) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment) || !nonempty(attachment.uri)) throw new Error("Each attachment requires a URI.");
    try { new URL(attachment.uri); } catch { throw new Error("Each attachment URI must be valid."); }
    if (attachment.name !== undefined && !nonempty(attachment.name)) throw new Error("Attachment names must be nonempty.");
    if (attachment.media_type !== undefined && !nonempty(attachment.media_type)) throw new Error("Attachment media types must be nonempty.");
  }
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) throw new Error("metadata must be an object.");
  if (input.metadata !== undefined && jsonSize(input.metadata) > 100_000) throw new Error("metadata exceeds 100,000 encoded bytes.");
  if (input.conversation !== undefined) {
    if (!input.conversation || typeof input.conversation !== "object" || Array.isArray(input.conversation)) throw new Error("conversation must be an object.");
    if (!nonempty(input.conversation.link) || input.conversation.link.length > 2_048) throw new Error("conversation.link must be a nonempty string of at most 2,048 characters.");
    if (input.conversation.snapshot === undefined || jsonSize(input.conversation.snapshot) > 1_000_000) throw new Error("conversation.snapshot is required and must not exceed 1,000,000 encoded bytes.");
    if (input.conversation.live_context !== undefined && jsonSize(input.conversation.live_context) > 1_000_000) throw new Error("conversation.live_context exceeds 1,000,000 encoded bytes.");
  }
  if (input.idempotency_key !== undefined && (!nonempty(input.idempotency_key) || input.idempotency_key.length > 500)) throw new Error("idempotency_key must be a nonempty string of at most 500 characters.");
  return normalizeDepotIntake({
    content: input.content,
    ...(input.project_hint === undefined ? {} : { project_hint: input.project_hint }),
    ...(input.context === undefined ? {} : { context: structuredClone(input.context) }),
    ...(input.attachments === undefined ? {} : { attachments: structuredClone(input.attachments) }),
    ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
    ...(input.conversation === undefined ? {} : { conversation: structuredClone(input.conversation) }),
  }, adapter);
}

export class RoundhouseService {
  constructor({ stateDirectory, configFile, store, engine } = {}) {
    this.store = store ?? new Store(stateDirectory);
    this.configFile = configFile ?? engine?.config?.filename ?? null;
    this.config = engine?.config ?? (configFile ? loadWorkflowConfig(configFile) : null);
    this.engine = engine ?? (this.config ? new Engine({ store: this.store, config: this.config }) : null);
    // Idempotent domain migration through the persistence boundary. This keeps
    // the service compatible with alternate stores while upgrading legacy data.
    this.initialization = this.store.shared ? null : this.runMigrations();
  }

  async runMigrations() {
    await migrateLegacyDecisionQuestions(this.store);
    return promoteProjectCandidates(this.store, this.config?.projects ?? []);
  }

  async initialize() {
    if (!this.initialization) this.initialization = this.runMigrations();
    await this.initialization;
    return this;
  }

  addToDepot(input, adapter = { source: "external", actor: "external-user" }) {
    const normalized = normalizeIntake(input, adapter);
    const key = nonempty(input.idempotency_key) ? `external:${input.idempotency_key}` : `external:${randomUUID()}`;
    return mapResult(submitToDepot(this.store, normalized, key, adapter), (item) =>
      mapResult(this.store.read(), (data) => ({ item: itemView(data, item), durable: true })));
  }

  async initiateProject(input, adapter = { source: "web", actor: "local-user" }) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Project initiation must be an object.");
    const outcome = projectInitiationValue(input.outcome ?? input.purpose, "an outcome", { required: true });
    const name = projectInitiationValue(input.name, "name", { limit: 200 }) ?? inferredProjectName(outcome);
    const repository = projectInitiationValue(input.repository, "repository", { limit: 2_000 });
    const successState = projectInitiationValue(input.success_state, "success state");
    const boundaries = projectInitiationValue(input.boundaries, "boundaries");
    if (input.trusted !== undefined && typeof input.trusted !== "boolean") throw new Error("trusted must be boolean.");
    const trusted = input.trusted === true;
    if (!this.configFile) throw new Error("Roundhouse configuration is required to create a project.");
    const rawConfiguration = readWorkflowConfig(this.configFile);
    const id = projectSlug(name);
    if (this.config?.projects?.some((project) => project.id === id || project.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A configured project already uses the name ${name}.`);
    }
    const brief = { name, outcome, repository, success_state: successState, boundaries, trusted };
    const details = [
      "Initiate a new Roundhouse project.",
      `Project name: ${name}`,
      `Desired outcome: ${outcome}`,
      repository ? `Repository or starting point: ${repository}` : "Repository or starting point: Roundhouse should recommend the safest appropriate starting point.",
      successState ? `Success looks like: ${successState}` : "Success looks like: Roundhouse should define a concrete, verifiable success state.",
      boundaries ? `Boundaries: ${boundaries}` : "Boundaries: Preserve existing data and authority; ask before consequential, destructive, financial, or external actions.",
      trusted
        ? "Decision mode: I trust Roundhouse to decide the remaining reversible implementation and product details using safe defaults."
        : "Decision mode: Use these answers as the project brief and ask one concise question at a time for any material unresolved decision.",
    ];
    rawConfiguration.projects ??= [];
    rawConfiguration.projects.push({
      id,
      name,
      status: "active",
      purpose: outcome,
      success_state: successState ?? `Deliver a concrete, reviewable result for: ${outcome}`,
      repository_required: false,
      required_capabilities: [],
      verification: [],
      policy: {
        allow_autonomous: trusted,
        approval_required: !trusted,
        review_after_shipping: true,
        shipping: "durable_output",
        continuation: "stop_after_job",
        max_rework_attempts: 1,
      },
      executor: { kind: "codex", bin: "codex" },
    });
    this.config = saveWorkflowConfig(this.configFile, rawConfiguration);
    this.engine = new Engine({ store: this.store, config: this.config });
    const created = await this.addToDepot({
      content: details.join("\n\n"), project_hint: id,
      metadata: { kind: "project_initiation", project_brief: brief },
      ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
    }, adapter);
    await this.store.change((data) => {
      const item = data.items[created.item.id];
      if (item) item.project_id = id;
      data.projects[id] = { ...data.projects[id], id, name, configured: true, repository: null,
        repository_required: false, source_system: adapter.source, project_brief: brief };
    });
    const data = await this.store.read();
    return { item: itemView(data, data.items[created.item.id]), project: data.projects[id], durable: true };
  }

  assignProject({ item_id, expected_item_revision, project_id, project_hint, actor = "local-user" }) {
    if (!nonempty(item_id)) throw new Error("Project assignment requires an item ID.");
    if (!Number.isInteger(expected_item_revision) || expected_item_revision < 1) throw new Error("Project assignment requires the current item revision.");
    if (Boolean(nonempty(project_id)) === Boolean(nonempty(project_hint))) throw new Error("Choose exactly one project target.");
    return this.store.change((data) => {
      const item = data.items[item_id];
      if (!item) throw new Error(`Unknown item: ${item_id}`);
      if (item.revision !== expected_item_revision) throw new Error("Project assignment is stale; refresh before retrying.");
      if ((item.job_ids ?? []).length) throw new Error("Planned or started work cannot be reassigned as a single item; replan it first.");
      const target = project_id
        ? this.config?.projects?.find((project) => project.id === project_id) ?? data.projects?.[project_id]
        : this.config?.projects?.find((project) => project.id === project_hint || project.name.toLowerCase() === project_hint.toLowerCase());
      const id = target?.id ?? projectSlug(project_hint);
      const name = target?.name ?? project_hint;
      data.projects[id] = { ...data.projects[id], id, name, configured: Boolean(this.config?.projects?.some((project) => project.id === id)),
        repository: target?.repository ?? data.projects[id]?.repository ?? null,
        repository_required: target?.repository_required ?? data.projects[id]?.repository_required ?? false };
      item.project_id = id;
      item.selected_project = id;
      item.input.project_id = id;
      delete item.input.project_hint;
      if (item.project_candidate_id) item.legacy_project_candidate_id = item.project_candidate_id;
      delete item.project_candidate_id;
      item.requires_reevaluation = true;
      item.execution_eligible = false;
      item.revision += 1;
      item.updated_at = new Date().toISOString();
      item.history.push({ from: item.state, to: item.state, reason: `${actor} assigned this work to project ${name}.`, at: item.updated_at });
      item.triage ??= { attempts: [], failure_count: 0 };
      item.triage.retry_requested_at = item.updated_at;
      return { item: itemView(data, item), project: data.projects[id], assigned: true };
    });
  }

  jumpToFront({ item_id, expected_item_revision, actor = "local-user" }) {
    if (!nonempty(item_id)) throw new Error("Priority change requires an item ID.");
    return this.store.change((data) => {
      const item = data.items[item_id];
      if (!item) throw new Error(`Unknown item: ${item_id}`);
      if (item.revision !== expected_item_revision) throw new Error("Priority change is stale; refresh before retrying.");
      item.priority = "P0";
      item.priority_rank = -1;
      for (const jobId of item.job_ids ?? []) if (data.jobs[jobId]) data.jobs[jobId].priority_rank = -1;
      item.revision += 1;
      item.updated_at = new Date().toISOString();
      item.history.push({ from: item.state, to: item.state, reason: `${actor} moved this work to the front of the queue.`, at: item.updated_at });
      return { item: itemView(data, item), prioritized: true };
    });
  }

  getNeedsHuman(filters = {}) {
    return mapResult(this.store.read(), (data) => needsHumanView(data, validateFilters(filters)));
  }

  getWorkStatus(filters = {}) {
    return mapResult(this.store.read(), (data) => statusView(data, validateFilters(filters)));
  }

  getDashboardProjection({ connection = {} } = {}) {
    return mapResult(this.store.read(), (data) => dashboardProjection(data, this.config ?? { projects: [] }, { connection }));
  }

  getNotifications(options = {}) {
    return mapResult(this.store.read(), (data) => notificationView(data, options));
  }

  getConfiguration() {
    if (!this.configFile) throw new Error("Roundhouse configuration file is unavailable.");
    return { file: this.configFile, configuration: readWorkflowConfig(this.configFile) };
  }

  saveConfiguration(configuration) {
    if (!this.configFile) throw new Error("Roundhouse configuration file is unavailable.");
    this.config = saveWorkflowConfig(this.configFile, configuration);
    this.engine = new Engine({ store: this.store, config: this.config });
    return this.getConfiguration();
  }

  approveItem({ id, expected_revision, actor = "local-user" }) {
    if (!this.engine) throw new Error("Roundhouse configuration is required to approve work.");
    return mapResult(this.engine.approve(id, expected_revision, actor), (item) =>
      mapResult(this.store.read(), (data) => ({ item: itemView(data, item), approved: true })));
  }

  async answerQuestion({ id, answer, expected_revision, actor = "chatgpt-user" }) {
    if (!this.engine) throw new Error("Roundhouse configuration is required to re-evaluate an answer.");
    const item = await this.engine.answerQuestion(id, answer, actor, expected_revision);
    return { item: itemView(await this.store.read(), item), answer_recorded: true, reevaluated: true };
  }

  async answerDecisionSession({ item_id, expected_item_revision, answers, actor = "local-user" }) {
    if (!this.engine) throw new Error("Roundhouse configuration is required to re-evaluate decision answers.");
    const item = await this.engine.answerDecisionSession(item_id, expected_item_revision, answers, actor);
    return { item: itemView(await this.store.read(), item), answers_recorded: answers.length, reevaluated: true };
  }

  async reconsiderItem({ id, expected_revision, actor = "local-user" }) {
    if (!this.engine) throw new Error("Roundhouse configuration is required to reconsider work.");
    const item = await this.engine.reconsider(id, actor, expected_revision);
    return { item: itemView(await this.store.read(), item), reconsidered: true };
  }

  async reevaluateImportedItem({ id, expected_revision, actor = "local-user" }) {
    if (!this.engine) throw new Error("Roundhouse configuration is required to re-evaluate imported work.");
    const item = await this.engine.reevaluateImported(id, expected_revision, actor);
    return { item: itemView(await this.store.read(), item), reevaluated: true };
  }

  retryTriage({ id, expected_revision, actor = "local-user" }) {
    if (!this.engine) throw new Error("Roundhouse configuration is required to retry triage.");
    return mapResult(this.engine.retryTriage(id, expected_revision, actor), (item) =>
      mapResult(this.store.read(), (data) => ({ item: itemView(data, item), retry_requested: true })));
  }

  async explodeJob({ id, expected_revision, actor = "local-user", note = "Operator removed a blocked job." }) {
    if (!this.engine) throw new Error("Roundhouse configuration is required to remove blocked work.");
    return await this.engine.explodeJob(id, { expectedRevision: expected_revision, actor, note });
  }

  async explodeItem({ id, expected_revision, actor = "local-user", note = "Operator removed an unresolved idea." }) {
    if (!this.engine) throw new Error("Roundhouse configuration is required to remove unresolved work.");
    return await this.engine.explodeItem(id, { expectedRevision: expected_revision, actor, note });
  }

  resolveIssue({ issue_id, expected_revision, action, message, actor = "local-user" }) {
    if (!nonempty(issue_id) || !Number.isInteger(expected_revision) || expected_revision < 1) throw new Error("Issue resolution requires an ID and current revision.");
    if (!nonempty(action) || !nonempty(message) || message.length > 20_000) throw new Error("Issue resolution requires an action and concise response.");
    return this.store.change((data) => {
      const entity = data.jobs?.[issue_id] ?? data.items?.[issue_id];
      if (!entity || !["Blocked", "Needs Clarification"].includes(entity.state)) throw new Error("Only Blocked or Needs Clarification work can be resolved here.");
      if (entity.revision !== expected_revision) throw new Error("Stale issue revision; review the latest state before answering.");
      const prior = entity.issue_resolution;
      entity.issue_resolution = { ...(prior ?? {}), status: "answered", response: { action, message, actor, at: new Date().toISOString() } };
      data.system_metadata ??= {};
      data.system_metadata.cleanup_metrics ??= { decisions: 0, deleted: 0, repurposed: 0, asked: 0, kept: 0,
        work_released: 0, operator_answers: 0, operator_accepted: 0, invalidated: 0, deleted_recreated: 0,
        repurposed_shipped: 0, decision_latency_ms: 0, decision_log: [] };
      data.system_metadata.cleanup_metrics.operator_answers += 1;
      if (action === "option") data.system_metadata.cleanup_metrics.operator_accepted += 1;
      entity.revision += 1;
      entity.updated_at = entity.issue_resolution.response.at;
      entity.history.push({ from: entity.state, to: entity.state, reason: `Cleanup guidance recorded by ${actor}: ${message}`, at: entity.updated_at });
      return { recorded: true, id: entity.id, revision: entity.revision, issue_resolution: entity.issue_resolution };
    });
  }

  getStorageStatus() {
    return this.store.status();
  }
}
