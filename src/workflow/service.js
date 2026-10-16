import { randomUUID } from "node:crypto";
import { Engine } from "./engine.js";
import { Store } from "./store.js";
import { loadWorkflowConfig, readWorkflowConfig, saveWorkflowConfig } from "./config.js";
import { normalizeDepotIntake, submitToDepot } from "./intake-contract.js";
import { dashboardProjection, itemView, needsHumanView, notificationView, statusView } from "./views.js";
import { mapResult } from "../storage/repository.js";
import { migrateLegacyDecisionQuestions } from "./legacy-decisions.js";
import { promoteProjectCandidates, projectSlug } from "./project-model.js";
import { broadIntentReady, initialIntent, makeFeature, makeGoal, projectCollection, rawIdeaEvidence, validateOptions } from "./intent-program.js";

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const jsonSize = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const FEATURE_INTENT_FIELDS = new Set(["why", "problem", "desired_outcome", "success_criteria", "research", "proposed_options"]);
const FEATURE_INTENT_LIST_FIELDS = new Set(["success_criteria", "research", "proposed_options"]);

function normalizeFeatureIntentFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Feature intent fields must be an object.");
  const keys = Object.keys(fields);
  if (!keys.length) throw new Error("Choose at least one feature intent field to update.");
  if (keys.some((key) => !FEATURE_INTENT_FIELDS.has(key))) throw new Error("Feature intent contains unsupported fields.");
  return Object.fromEntries(keys.map((key) => {
    const value = fields[key];
    if (value === null || value === "") return [key, null];
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized.length > 12_000) throw new Error(`${key} exceeds 12,000 characters.`);
      return [key, normalized || null];
    }
    if (FEATURE_INTENT_LIST_FIELDS.has(key) && Array.isArray(value)) {
      if (value.length > 50 || value.some((entry) => typeof entry !== "string" || entry.length > 4_000)) {
        throw new Error(`${key} must contain at most 50 text entries of 4,000 characters each.`);
      }
      return [key, value.map((entry) => entry.trim()).filter(Boolean)];
    }
    throw new Error(`${key} must be text${FEATURE_INTENT_LIST_FIELDS.has(key) ? " or a list of text" : ""}.`);
  }));
}

function inferredFeatureId(item) {
  if (nonempty(item?.intent?.feature_id)) return item.intent.feature_id.trim();
  if (nonempty(item?.feature_id)) return item.feature_id.trim();
  const intentId = item?.intent?.id ?? item?.intent_id ?? item?.id;
  return nonempty(intentId) ? `intent:${intentId.trim()}` : null;
}

function inferredFeatureTitle(items) {
  for (const item of items) {
    const title = item.intent?.fields?.title ?? item.intent?.summary;
    if (nonempty(title)) return title.trim().slice(0, 2_000);
  }
  for (const item of items) {
    const title = item.input?.text?.split(/\r?\n/).find((line) => line.trim());
    if (nonempty(title)) return title.trim().slice(0, 2_000);
  }
  return "Untitled intent";
}

function promoteInferredFeature(featureId, items, actor, at, projectRevision) {
  const ordered = [...items].sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""))
    || left.id.localeCompare(right.id));
  const intentValue = (field) => {
    for (const item of ordered) {
      const value = item.intent?.fields?.[field];
      if (value !== undefined) return structuredClone(value);
    }
    return undefined;
  };
  const firstIntent = ordered.find((item) => item.intent)?.intent;
  const description = intentValue("description") ?? firstIntent?.summary ?? ordered[0]?.input?.text ?? null;
  const goalIds = [...new Set(ordered.flatMap((item) => Array.isArray(item.intent?.goal_ids) ? item.intent.goal_ids : [])
    .filter(nonempty).map((id) => id.trim()))];
  const derived = Object.fromEntries([...FEATURE_INTENT_FIELDS].flatMap((field) => {
    const value = intentValue(field);
    return value === undefined ? [] : [[field, value]];
  }));
  const feature = {
    id: featureId,
    title: inferredFeatureTitle(ordered),
    description: structuredClone(description),
    ...derived,
    completion_type: firstIntent?.completion_type ?? "Done when shipped",
    goal_ids: goalIds,
    status: "Planned",
    evidence: [],
    progress: null,
    work_item_ids: ordered.map((item) => item.id),
    revision: 1,
    intent_audit: [],
    created_at: at,
    updated_at: at,
    created_by: actor,
  };
  feature.intent_audit.push({ revision: 1, project_revision: projectRevision, actor,
    source: "inferred-intent-promotion", action: "promoted", changed_fields: Object.keys(derived),
    previous: null, values: { title: feature.title, description: feature.description, ...structuredClone(derived) },
    work_item_ids: [...feature.work_item_ids], recorded_at: at });
  return feature;
}

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
    return mapResult(submitToDepot(this.store, normalized, key, adapter), (submitted) => mapResult(this.store.change((data) => {
      const item = data.items[submitted.id];
      if (!item.raw_idea) {
        const capturedAt = item.created_at ?? new Date().toISOString();
        item.raw_idea = rawIdeaEvidence(item.input, capturedAt);
        item.intent = initialIntent(item.input, capturedAt);
      }
      return item;
    }), (item) => mapResult(this.store.read(), (data) => ({ item: itemView(data, item), durable: true }))));
  }

  createGoal({ project_id, expected_project_revision, goal, actor = "local-user" }) {
    if (!nonempty(project_id) || !Number.isInteger(expected_project_revision) || expected_project_revision < 1) throw new Error("Goal creation requires a project id and current revision.");
    return this.store.change((data) => {
      const project = projectCollection(data.projects?.[project_id] ?? (data.projects[project_id] = { id: project_id,
        name: this.config?.projects?.find((candidate) => candidate.id === project_id)?.name ?? project_id }));
      if (project.revision !== expected_project_revision) throw new Error("Project changed; refresh before adding the goal.");
      const created = makeGoal(goal, actor);
      if (project.goals.some((candidate) => candidate.id === created.id)) throw new Error("Goal id already exists.");
      project.goals.push(created);
      project.revision += 1;
      project.updated_at = created.created_at;
      return { goal: structuredClone(created), project_revision: project.revision };
    });
  }

  setProjectIcon({ project_id, expected_project_revision, icon, actor = "local-user" }) {
    if (!nonempty(project_id) || !Number.isInteger(expected_project_revision) || expected_project_revision < 1) {
      throw new Error("Project icon update requires a project id and current revision.");
    }
    // Persist one Unicode emoji grapheme, never arbitrary markup or URLs.
    const chars = typeof icon === "string" ? [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(icon)] : [];
    if (typeof icon !== "string" || icon.length > 18 || chars.length !== 1 || !/\p{Extended_Pictographic}/u.test(icon)) {
      throw new Error("Project icon must be one emoji.");
    }
    return this.store.change((data) => {
      const configured = this.config?.projects?.some((project) => project.id === project_id);
      const current = data.projects?.[project_id];
      if (!configured && !current) throw new Error("Unknown project.");
      data.projects ??= {};
      const project = projectCollection(current ?? (data.projects[project_id] = {
        id: project_id, name: this.config.projects.find((entry) => entry.id === project_id)?.name ?? project_id,
      }));
      if (project.revision !== expected_project_revision) throw new Error("Project changed; refresh before changing the icon.");
      project.icon = icon;
      project.icon_updated_at = new Date().toISOString();
      project.icon_updated_by = actor;
      project.revision += 1;
      project.updated_at = project.icon_updated_at;
      return { id: project_id, icon: project.icon, project_revision: project.revision };
    });
  }

  createFeature({ project_id, expected_project_revision, feature, actor = "local-user" }) {
    if (!nonempty(project_id) || !Number.isInteger(expected_project_revision) || expected_project_revision < 1) throw new Error("Feature creation requires a project id and current revision.");
    return this.store.change((data) => {
      const project = projectCollection(data.projects?.[project_id] ?? (data.projects[project_id] = { id: project_id,
        name: this.config?.projects?.find((candidate) => candidate.id === project_id)?.name ?? project_id }));
      if (project.revision !== expected_project_revision) throw new Error("Project changed; refresh before adding the feature.");
      const created = makeFeature(feature, project.goals, actor);
      if (project.features.some((candidate) => candidate.id === created.id)) throw new Error("Feature id already exists.");
      project.features.push(created);
      project.revision += 1;
      project.updated_at = created.created_at;
      return { feature: structuredClone(created), project_revision: project.revision };
    });
  }

  updateFeatureIntent({ project_id, feature_id, expected_project_revision, expected_feature_revision,
    fields, clarification_behavior = "ask_if_required", actor = "local-user" }) {
    if (!nonempty(project_id) || !nonempty(feature_id) || !Number.isInteger(expected_project_revision) || expected_project_revision < 1) {
      throw new Error("Feature intent update requires project, feature, and current project revision.");
    }
    if (expected_feature_revision !== undefined
      && (!Number.isInteger(expected_feature_revision) || expected_feature_revision < 1)) {
      throw new Error("Feature intent revision must be a positive integer.");
    }
    if (clarification_behavior !== "ask_if_required") throw new Error("Unsupported feature intent clarification behavior.");
    if (!nonempty(actor)) throw new Error("Feature intent update requires an authenticated actor.");
    const normalized = normalizeFeatureIntentFields(fields);
    return this.store.change((data) => {
      const matchingItems = () => Object.values(data.items ?? {}).filter((item) => inferredFeatureId(item) === feature_id);
      const existing = data.projects?.[project_id];
      let project = existing ? projectCollection(existing) : null;
      if (!project) {
        const linkedItems = matchingItems();
        if (!linkedItems.length || linkedItems.some((item) => item.project_id !== project_id)) {
          throw new Error("Feature is outside this project or does not exist.");
        }
        if (expected_project_revision !== 1) throw new Error("Project changed; refresh before updating feature intent.");
        data.projects ??= {};
        const configured = this.config?.projects?.find((candidate) => candidate.id === project_id);
        project = projectCollection(data.projects[project_id] = {
          id: project_id, ...(configured?.name ? { name: configured.name } : {}), revision: 1,
        });
      }
      if (project.revision !== expected_project_revision) throw new Error("Project changed; refresh before updating feature intent.");
      let feature = project.features.find((candidate) => candidate.id === feature_id);
      let promoted = false;
      if (!feature) {
        const linkedItems = matchingItems();
        if (!linkedItems.length || linkedItems.some((item) => item.project_id !== project_id)) {
          throw new Error("Feature is outside this project or does not exist.");
        }
        const at = new Date().toISOString();
        feature = promoteInferredFeature(feature_id, linkedItems, actor.trim(), at, project.revision + 1);
        project.features.push(feature);
        promoted = true;
      }
      const featureRevision = feature.revision ?? 1;
      if (expected_feature_revision !== undefined && featureRevision !== expected_feature_revision) {
        throw new Error("Feature changed; refresh before updating feature intent.");
      }

      const at = new Date().toISOString();
      const previous = Object.fromEntries(Object.keys(normalized).map((key) => [key,
        feature[key] === undefined ? null : structuredClone(feature[key])]));
      for (const [key, value] of Object.entries(normalized)) feature[key] = structuredClone(value);
      feature.revision = featureRevision + 1;
      feature.updated_at = at;
      feature.intent_audit ??= [];
      feature.intent_audit.push({ revision: feature.revision, project_revision: project.revision + 1,
        actor: actor.trim(), source: "dashboard-command", action: promoted ? "promoted-and-updated" : "updated",
        changed_fields: Object.keys(normalized), previous,
        values: structuredClone(normalized), clarification_behavior, recorded_at: at });
      project.revision += 1;
      project.updated_at = at;

      // Feature intent edits do not manufacture blockers from optional blanks.
      // If linked discovery work already has a consequential open question, it
      // remains in the canonical item/question Inbox flow.
      const inboxItemIds = (feature.work_item_ids ?? []).filter((id) => {
        const item = data.items?.[id];
        return item?.state === "Needs Clarification" && (item.questions ?? []).some((question) => question.status === "open");
      });
      return { feature: structuredClone(feature), project_revision: project.revision,
        feature_revision: feature.revision, clarification_required: inboxItemIds.length > 0,
        inbox_item_ids: inboxItemIds };
    });
  }

  answerIntentQuestion({ item_id, expected_item_revision, question_id, expected_question_revision, answer, fields = {}, next_question, actor = "local-user" }) {
    if (!nonempty(item_id) || !Number.isInteger(expected_item_revision) || expected_item_revision < 1 || !nonempty(question_id)
      || !Number.isInteger(expected_question_revision) || expected_question_revision < 1 || !nonempty(answer)) {
      throw new Error("Intent clarification requires current item/question revisions and a nonempty answer.");
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Intent fields must be an object.");
    if (next_question !== undefined && (!next_question || typeof next_question !== "object" || !nonempty(next_question.prompt) || !nonempty(next_question.field))) {
      throw new Error("A next question requires one prompt and field.");
    }
    return this.store.change((data) => {
      const item = data.items[item_id];
      if (!item?.intent?.discovery_non_executable || item.revision !== expected_item_revision || item.job_ids?.length) throw new Error("Intent clarification is stale or not applicable.");
      const question = (item.questions ?? []).find((candidate) => candidate.id === question_id);
      if (!question || question.status !== "open" || question.revision !== expected_question_revision) throw new Error("Intent question is stale or already answered.");
      const at = new Date().toISOString();
      question.answer = { text: answer.trim(), actor, at };
      question.status = "answered";
      question.revision += 1;
      question.updated_at = at;
      item.clarifications.push({ text: answer.trim(), actor, question_id, decision_id: question.decision_id,
        decision_key: question.decision_key ?? null, at });
      item.intent.fields = { ...item.intent.fields, ...structuredClone(fields) };
      item.intent.confirmed_fields = [...new Set([...item.intent.confirmed_fields, ...Object.keys(fields)])];
      item.intent.unresolved_questions = [];
      if (next_question) {
        const followup = { id: randomUUID(), decision_id: item.decision_id ?? null, decision_key: `intent:${next_question.field}`,
          item_id: item.id, item_revision: item.revision + 1, revision: 1, kind: "clarification", prompt: next_question.prompt.trim(),
          intent_field: next_question.field.trim(), status: "open", created_at: at, updated_at: at };
        item.questions.push(followup);
        item.intent.unresolved_questions = [{ id: followup.id, field: followup.intent_field, prompt: followup.prompt }];
        item.intent.status = "discovering";
      } else item.intent.status = "ready_for_confirmation";
      item.intent.updated_at = at;
      item.revision += 1;
      item.updated_at = at;
      item.history.push({ from: item.state, to: item.state, reason: `${actor} clarified intent without authorizing execution.`, at });
      return { item: itemView(data, item), answer_recorded: true, reevaluated: false };
    });
  }

  confirmIntent({ item_id, expected_item_revision, fields = {}, feature_id, goal_ids, actor = "local-user" }) {
    if (!nonempty(item_id) || !Number.isInteger(expected_item_revision) || expected_item_revision < 1) throw new Error("Intent confirmation requires an item id and current revision.");
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Intent fields must be an object.");
    return this.store.change((data) => {
      const item = data.items[item_id];
      if (!item?.intent?.discovery_non_executable || item.revision !== expected_item_revision || item.job_ids?.length) throw new Error("Intent confirmation is stale or not applicable.");
      if ((item.questions ?? []).some((question) => question.status === "open")) throw new Error("Answer the current consequential question before confirming intent.");
      if (!item.decision?.work_items?.length) throw new Error("Intent needs a reviewable plan before confirmation.");
      const project = projectCollection(data.projects?.[item.project_id] ?? (data.projects[item.project_id] = { id: item.project_id, name: item.project_id }));
      const selectedFeature = feature_id ?? item.intent.feature_id;
      if (selectedFeature && !project.features.some((feature) => feature.id === selectedFeature)) throw new Error("Intent references an unknown feature.");
      const selectedGoals = goal_ids ?? item.intent.goal_ids;
      if (!Array.isArray(selectedGoals) || selectedGoals.some((id) => !project.goals.some((goal) => goal.id === id))) throw new Error("Intent references an unknown goal.");
      const proposedFields = { ...item.intent.fields, ...structuredClone(fields) };
      const proposedConfirmation = { ...item.intent, fields: proposedFields,
        confirmed_fields: [...new Set([...item.intent.confirmed_fields, ...Object.keys(fields)])] };
      if (!broadIntentReady(proposedConfirmation, item.project_id ?? item.input.project_id ?? item.input.project_hint)) {
        throw new Error("Broad intent requires confirmed problem, desired outcome, success criteria, scope boundaries, and resolved consequential questions.");
      }
      const at = new Date().toISOString();
      item.intent.versions.push({ version: item.intent.version, summary: item.intent.summary, fields: structuredClone(item.intent.fields),
        confirmed_fields: [...item.intent.confirmed_fields], recorded_at: at });
      item.intent.version += 1;
      item.intent.fields = { ...item.intent.fields, ...structuredClone(fields) };
      item.intent.confirmed_fields = [...new Set([...item.intent.confirmed_fields, ...Object.keys(fields)])];
      item.intent.feature_id = selectedFeature ?? null;
      item.intent.goal_ids = [...new Set(selectedGoals)];
      item.intent.status = "confirmed";
      item.intent.planning_confirmation = { actor, item_revision: expected_item_revision, at };
      item.intent.updated_at = at;
      if (selectedFeature) {
        const feature = project.features.find((candidate) => candidate.id === selectedFeature);
        if (!feature.work_item_ids.includes(item.id)) feature.work_item_ids.push(item.id);
        feature.updated_at = at;
        project.revision += 1;
        project.updated_at = at;
      }
      if (item.state === "Needs Clarification") this.store.move(data, item, "Decision", "Confirmed intent is entering execution review; no work was created.");
      if (item.state === "Decision") this.store.move(data, item, "Review", "Product direction confirmed; explicit execution approval is still required.");
      else if (item.state === "Review") {
        item.revision += 1; item.updated_at = at;
        item.history.push({ from: "Review", to: "Review", reason: "Product direction confirmed; explicit execution approval is still required.", at });
      } else throw new Error("Intent can only be confirmed from clarification or review.");
      return { item: itemView(data, item), planning_confirmed: true, execution_approved: false };
    });
  }

  proposeResearch({ project_id, expected_project_revision, feature_id, unknown, options, recommendation, citations, external_action = false, actor = "local-user" }) {
    if (!nonempty(project_id) || !Number.isInteger(expected_project_revision) || expected_project_revision < 1 || !nonempty(unknown) || !nonempty(recommendation)) {
      throw new Error("Research proposal requires project/revision, a decision-changing unknown, and recommendation.");
    }
    if (!Array.isArray(citations) || !citations.length || citations.some((citation) => !citation || !nonempty(citation.source) || !nonempty(citation.reference))) {
      throw new Error("Research proposals require grounded citations with source and reference.");
    }
    if (typeof external_action !== "boolean") throw new Error("external_action must be boolean.");
    const candidates = validateOptions(options);
    return this.store.change((data) => {
      const existing = data.projects?.[project_id];
      if (!existing) throw new Error("Unknown project.");
      const project = projectCollection(existing);
      if (project.revision !== expected_project_revision) throw new Error("Project changed; refresh before recording research.");
      const feature = feature_id ? project.features.find((candidate) => candidate.id === feature_id) : null;
      if (feature_id && !feature) throw new Error("Research references an unknown feature.");
      const at = new Date().toISOString();
      const proposal = { id: randomUUID(), kind: "evidence_request", unknown: unknown.trim(), options: candidates,
        recommendation: recommendation.trim(), citations: structuredClone(citations), provenance: { actor, recorded_at: at },
        external_action, status: external_action ? "approval_required" : "proposed", created_at: at, updated_at: at };
      project.research_tasks.push(proposal);
      if (feature) feature.proposed_options.push(proposal.id);
      project.revision += 1;
      project.updated_at = at;
      return { research: structuredClone(proposal), project_revision: project.revision, dispatched: false };
    });
  }

  evaluateGoal({ project_id, expected_project_revision, goal_id, evidence, metrics = {}, data_status = "available", hypotheses = [], experiments = [], next_evaluation_at = null, actor = "local-user" }) {
    if (!nonempty(project_id) || !Number.isInteger(expected_project_revision) || expected_project_revision < 1 || !nonempty(goal_id)) throw new Error("Goal evaluation requires project, goal, and current revision.");
    if (!Array.isArray(evidence) || evidence.some((entry) => !entry || !nonempty(entry.source) || !nonempty(entry.reference))) throw new Error("Goal evidence requires source and reference provenance.");
    if (!["available", "unavailable"].includes(data_status)) throw new Error("data_status must be available or unavailable.");
    if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) throw new Error("Goal metrics must be an object.");
    if (!Array.isArray(hypotheses) || hypotheses.some((entry) => !nonempty(entry)) || !Array.isArray(experiments)
      || experiments.some((entry) => !entry || typeof entry !== "object" || !nonempty(entry.title))) {
      throw new Error("Hypotheses must be text and experiments require titles.");
    }
    if (next_evaluation_at !== null && (!nonempty(next_evaluation_at) || Number.isNaN(Date.parse(next_evaluation_at)))) throw new Error("next_evaluation_at must be an ISO-8601 timestamp or null.");
    return this.store.change((data) => {
      const existing = data.projects?.[project_id];
      if (!existing) throw new Error("Unknown project.");
      const project = projectCollection(existing);
      if (project.revision !== expected_project_revision) throw new Error("Project changed; refresh before evaluating the goal.");
      const goal = project.goals.find((candidate) => candidate.id === goal_id);
      if (!goal) throw new Error("Unknown goal.");
      const target = goal.measurable_target;
      const measured = target?.metric ? Number(metrics[target.metric]) : NaN;
      const visits = Number(metrics.visits);
      const signups = Number(metrics.signups);
      let result = "progressing";
      if (data_status === "unavailable" || evidence.length === 0) result = "data_unavailable";
      else if (Number.isFinite(visits) && visits === 0) result = "no_traffic";
      else if (target && Number.isFinite(measured) && Number.isFinite(Number(target.value)) && measured >= Number(target.value)) result = "achieved_target";
      else if (Number.isFinite(visits) && visits > 0 && Number.isFinite(signups)
        && target?.metric === "conversion_rate" && signups / visits < Number(target.value)) result = "poor_conversion";
      const at = new Date().toISOString();
      const evaluation = { id: randomUUID(), run_kind: "explicit", result, metrics: structuredClone(metrics), evidence: structuredClone(evidence),
        hypotheses: structuredClone(hypotheses), experiments: structuredClone(experiments).map((experiment) => ({ ...experiment, status: "proposed", decision_required: true })),
        actor, evaluated_at: at };
      goal.evaluations.push(evaluation);
      goal.evidence.push(...structuredClone(evidence));
      goal.progress = { result, metrics: structuredClone(metrics), evaluated_at: at };
      goal.next_evaluation_at = next_evaluation_at;
      goal.proposed_options.push(...evaluation.experiments.map((experiment) => experiment.id ?? experiment.title).filter(Boolean));
      goal.updated_at = at;
      if (result === "achieved_target") {
        goal.status = "Achieved";
        for (const feature of project.features.filter((candidate) => candidate.completion_type === "Done when outcome reached" && candidate.goal_ids.includes(goal.id))) {
          if (feature.goal_ids.every((id) => project.goals.find((candidate) => candidate.id === id)?.status === "Achieved")) feature.status = "Achieved";
        }
      }
      project.revision += 1;
      project.updated_at = at;
      return { evaluation: structuredClone(evaluation), goal: structuredClone(goal), project_revision: project.revision };
    });
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
      repositories: [],
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
      data.projects[id] = { ...data.projects[id], id, name, configured: true, repository: null, repositories: [],
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

  // One human-facing review contract. Revision, dependency and execution
  // policy remain server-owned; a UI label never bypasses the existing guards.
  async reviewAction({ item_id, expected_revision, choice, note = "", actor = "local-user" }) {
    if (!nonempty(item_id) || !Number.isInteger(expected_revision) || expected_revision < 1) {
      throw new Error("Review action requires the current item identity and revision.");
    }
    if (!["approve", "change", "retire"].includes(choice)) throw new Error("Unsupported review action.");
    if (typeof note !== "string" || note.length > 10_000) throw new Error("Review change exceeds 10,000 characters.");
    const direction = note.trim();
    if (choice === "change" && !direction) throw new Error("Change requires a short description of the new direction.");
    const data = await this.store.read();
    const entity = data.jobs?.[item_id] ?? data.items?.[item_id];
    if (!entity || entity.revision !== expected_revision) throw new Error("This review has changed. Roundhouse will refresh it before accepting another decision.");
    const isJob = Boolean(data.jobs?.[item_id]);
    const resolution = entity.issue_resolution;
    if (resolution?.status === "answered" && entity.state !== "Review") {
      throw new Error("This decision is already recorded. Roundhouse is processing the outcome.");
    }

    if (choice === "approve") {
      // Approval of remediation means approval of only the existing, exact
      // non-destructive resolution option; never execution/shipment approval.
      const planned = ["replan", "approve_spec_only"].map(id => resolution?.options?.find(option => option.id === id))
        .find(option => option && option.resolution !== "delete");
      if (["Blocked", "Needs Clarification"].includes(entity.state) && resolution?.status === "waiting" && planned) {
        const message = [planned.label, planned.description, ...(planned.effects ?? [])].filter(Boolean).join(" — ");
        const response = await this.resolveIssue({ issue_id: item_id, expected_revision, action: "option", message, actor });
        return { accepted: true, choice, action: "approved_existing_resolution", result: response,
          execution_approved: false, retired: false };
      }
      if (isJob) throw new Error("This work has no reviewable approval; Roundhouse must prepare a safe decision first.");
      if (entity.state === "Review") {
        const result = await this.approveItem({ id: item_id, expected_revision, actor });
        return { accepted: true, choice, action: "execution_approved", result };
      }
      if (entity.state === "Needs Clarification" && entity.intent?.status === "ready_for_confirmation") {
        const result = await this.confirmIntent({ item_id, expected_item_revision: expected_revision,
          fields: entity.intent.fields ?? {}, actor });
        return { accepted: true, choice, action: "plan_confirmed", result,
          execution_approved: false };
      }
      throw new Error("Roundhouse has not prepared an approvable plan. Use Change to give new direction.");
    }

    if (choice === "change") {
      if (isJob || (["Blocked", "Needs Clarification"].includes(entity.state) && resolution?.status === "waiting")) {
        if (!["Blocked", "Needs Clarification"].includes(entity.state)) throw new Error("Only held work can request a change here.");
        const result = await this.resolveIssue({ issue_id: item_id, expected_revision,
          action: "custom", message: direction, actor });
        return { accepted: true, choice, action: "change_requested", result, execution_approved: false };
      }
      if (entity.state !== "Review" && entity.state !== "Needs Clarification" && entity.state !== "Blocked") {
        throw new Error("This work is not waiting for a review decision.");
      }
      const open = (entity.questions ?? []).filter(question => question.status === "open");
      if (open.length) {
        // Answer exactly one question in this review. The batch decision-session
        // contract requires *all* open questions at once, so use its guarded
        // single-question sibling rather than force more forms onto the user.
        const result = await this.answerQuestion({ id: open[0].id, answer: direction,
          expected_revision: open[0].revision, actor });
        return { accepted: true, choice, action: "direction_answered", result };
      }
      const result = await this.store.change(state => {
        const current = state.items?.[item_id];
        if (!current || current.revision !== expected_revision || (current.job_ids ?? []).length
          || !["Review", "Needs Clarification", "Blocked"].includes(current.state)) {
          throw new Error("This review changed; no revised plan was started.");
        }
        current.clarifications ??= [];
        current.clarifications.push({ text: direction, actor, at: new Date().toISOString(), kind: "review_change" });
        this.store.move(state, current, "Decision", "Human revised the desired outcome; Roundhouse will replan without replaying work.");
        current.awaiting_decision = true;
        return { id: current.id, revision: current.revision, state: current.state };
      });
      return { accepted: true, choice, action: "replanning", result };
    }

    // Retire is archive-first. Retain the complete work and evidence rather
    // than confusing "retire" with immediate irreversible deletion.
    if (isJob) {
      const deleteOption = resolution?.status === "waiting"
        && resolution.options?.find(option => option.id === "delete-unverified-attempt" || option.id === "delete");
      if (!deleteOption) throw new Error("This attempted job needs a verified cleanup decision before retiring.");
      const dependents = Object.values(data.jobs ?? {}).filter(job => (job.dependencies ?? []).includes(item_id));
      if (dependents.length) throw new Error("Dependent work must be reconciled before retiring this job.");
      const message = [deleteOption.label, deleteOption.description, ...(deleteOption.effects ?? [])].filter(Boolean).join(" — ");
      const result = await this.resolveIssue({ issue_id: item_id, expected_revision, action: "option", message, actor });
      return { accepted: true, choice, action: "retirement_requested", result,
        retired: false, execution_approved: false };
    }
    const result = await this.store.change(state => {
      const current = state.items?.[item_id];
      if (!current || current.revision !== expected_revision || !["Review", "Needs Clarification", "Blocked"].includes(current.state)) {
        throw new Error("This review changed; nothing was retired.");
      }
      if ((current.job_ids ?? []).some(id => state.jobs?.[id])
        || Object.values(state.jobs ?? {}).some(job => (job.dependencies ?? []).includes(item_id))) {
        throw new Error("This item has dependent work. Roundhouse must resolve those dependencies before retirement.");
      }
      if ((current.processes ?? []).length || current.owning_node_id) {
        throw new Error("Roundhouse cannot retire work while execution may still be active.");
      }
      // All these lifecycle states can reach Decision, then Archived.
      this.store.move(state, current, "Decision", "Retirement approved for unstarted work.");
      this.store.move(state, current, "Archived", "Retired by " + actor + "; original context and audit history preserved.");
      current.issue_resolution = null;
      return { id: current.id, revision: current.revision, state: current.state };
    });
    return { accepted: true, choice, action: "archived", result, retired: true };
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
