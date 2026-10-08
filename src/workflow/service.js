import { randomUUID } from "node:crypto";
import { Engine } from "./engine.js";
import { Store } from "./store.js";
import { loadWorkflowConfig, readWorkflowConfig, saveWorkflowConfig } from "./config.js";
import { normalizeDepotIntake, submitToDepot } from "./intake-contract.js";
import { dashboardProjection, itemView, needsHumanView, notificationView, statusView } from "./views.js";
import { mapResult } from "../storage/repository.js";
import { migrateLegacyDecisionQuestions } from "./legacy-decisions.js";

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const jsonSize = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function validateFilters(filters) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new Error("Filters must be an object.");
  for (const key of Object.keys(filters)) if (!["item_id", "project_id"].includes(key)) throw new Error(`Unknown filter: ${key}`);
  for (const key of ["item_id", "project_id"]) if (filters[key] !== undefined && !nonempty(filters[key])) throw new Error(`${key} must be nonempty.`);
  return filters;
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
  if (input.idempotency_key !== undefined && (!nonempty(input.idempotency_key) || input.idempotency_key.length > 500)) throw new Error("idempotency_key must be a nonempty string of at most 500 characters.");
  return normalizeDepotIntake({
    content: input.content,
    ...(input.project_hint === undefined ? {} : { project_hint: input.project_hint }),
    ...(input.context === undefined ? {} : { context: structuredClone(input.context) }),
    ...(input.attachments === undefined ? {} : { attachments: structuredClone(input.attachments) }),
    ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
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
    this.initialization = this.store.shared ? null : migrateLegacyDecisionQuestions(this.store);
  }

  async initialize() {
    if (!this.initialization) this.initialization = migrateLegacyDecisionQuestions(this.store);
    await this.initialization;
    return this;
  }

  addToDepot(input, adapter = { source: "external", actor: "external-user" }) {
    const normalized = normalizeIntake(input, adapter);
    const key = nonempty(input.idempotency_key) ? `external:${input.idempotency_key}` : `external:${randomUUID()}`;
    return mapResult(submitToDepot(this.store, normalized, key, adapter), (item) =>
      mapResult(this.store.read(), (data) => ({ item: itemView(data, item), durable: true })));
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

  getStorageStatus() {
    return this.store.status();
  }
}
