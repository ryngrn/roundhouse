import { randomUUID } from "node:crypto";
import { Engine } from "./engine.js";
import { Store } from "./store.js";
import { loadWorkflowConfig, readWorkflowConfig, saveWorkflowConfig } from "./config.js";
import { normalizeDepotIntake, submitToDepot } from "./intake-contract.js";
import { itemView, needsHumanView, notificationView, statusView } from "./views.js";

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
  }

  addToDepot(input, adapter = { source: "external", actor: "external-user" }) {
    const normalized = normalizeIntake(input, adapter);
    const key = nonempty(input.idempotency_key) ? `external:${input.idempotency_key}` : `external:${randomUUID()}`;
    const item = submitToDepot(this.store, normalized, key, adapter);
    return { item: itemView(this.store.read(), item), durable: true };
  }

  getNeedsHuman(filters = {}) {
    return needsHumanView(this.store.read(), validateFilters(filters));
  }

  getWorkStatus(filters = {}) {
    return statusView(this.store.read(), validateFilters(filters));
  }

  getNotifications(options = {}) {
    return notificationView(this.store.read(), options);
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
    const item = this.engine.approve(id, expected_revision, actor);
    return { item: itemView(this.store.read(), item), approved: true };
  }

  async answerQuestion({ id, answer, expected_revision, actor = "chatgpt-user" }) {
    if (!this.engine) throw new Error("Roundhouse configuration is required to re-evaluate an answer.");
    const item = await this.engine.answerQuestion(id, answer, actor, expected_revision);
    return { item: itemView(this.store.read(), item), answer_recorded: true, reevaluated: true };
  }

  async reconsiderItem({ id, expected_revision, actor = "local-user" }) {
    if (!this.engine) throw new Error("Roundhouse configuration is required to reconsider work.");
    const item = await this.engine.reconsider(id, actor, expected_revision);
    return { item: itemView(this.store.read(), item), reconsidered: true };
  }
}
