import { createHash, randomUUID } from "node:crypto";

export const COMPLETION_TYPES = ["Done when shipped", "Done when outcome reached"];

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const now = () => new Date().toISOString();
const copy = (value) => value === undefined ? undefined : structuredClone(value);

function shortDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function classifyIntent(input) {
  const declared = input?.metadata?.intent_scope;
  if (declared !== undefined && !["broad", "tactical"].includes(declared)) {
    throw new Error("metadata.intent_scope must be broad or tactical.");
  }
  if (declared) return declared;
  if (input?.metadata?.kind === "project_initiation") return "broad";
  const text = input?.text ?? "";
  const strategic = /\b(strategy|program|platform|business|product direction|go-to-market|launch (?:a|the|our)|grow|increase (?:traffic|signups|revenue|conversion)|redesign (?:the|our)|new product)\b/i.test(text);
  const multiPart = /\b(and then|across|phases?|roadmap|multiple|end-to-end|research.+(?:build|launch)|build.+(?:measure|monitor))\b/i.test(text);
  return text.length >= 300 && strategic && multiPart ? "broad" : "tactical";
}

export function initialIntent(input, capturedAt = now()) {
  const scope = classifyIntent(input);
  const supplied = input.metadata?.intent && typeof input.metadata.intent === "object" ? input.metadata.intent : {};
  const completionType = supplied.completion_type ?? input.metadata?.completion_type ?? "Done when shipped";
  if (!COMPLETION_TYPES.includes(completionType)) throw new Error("completion_type must be exactly 'Done when shipped' or 'Done when outcome reached'.");
  const fields = supplied.fields && typeof supplied.fields === "object" && !Array.isArray(supplied.fields)
    ? copy(supplied.fields) : {};
  return {
    status: scope === "broad" ? "discovering" : "tactical_fast_lane",
    summary: nonempty(supplied.summary) ? supplied.summary.trim() : input.text.trim().slice(0, 2_000),
    fields,
    confirmed_fields: [],
    unresolved_questions: [],
    completion_type: completionType,
    original_context_reference: `raw-idea:${shortDigest({ text: input.text, context: input.context ?? null, conversation: input.conversation ?? null })}`,
    discovery_non_executable: scope === "broad",
    feature_id: nonempty(supplied.feature_id) ? supplied.feature_id.trim() : null,
    goal_ids: Array.isArray(supplied.goal_ids) ? [...new Set(supplied.goal_ids.filter(nonempty).map((id) => id.trim()))] : [],
    version: 1,
    versions: [],
    work_slices: [],
    created_at: capturedAt,
    updated_at: capturedAt,
  };
}

export function rawIdeaEvidence(input, capturedAt = now()) {
  const reference = initialIntent(input, capturedAt).original_context_reference;
  return {
    id: reference,
    captured_at: capturedAt,
    source: input.source,
    actor: input.actor,
    input_digest: shortDigest(input),
    text: input.text,
    context: copy(input.context ?? null),
    conversation: copy(input.conversation ?? null),
    attachments: copy(input.attachments ?? []),
  };
}

export function isBroadIntent(item) {
  return item?.intent?.discovery_non_executable === true;
}

// Confirm only the core product decision fields, not optional taxonomy/metrics.
export const REQUIRED_BROAD_INTENT_FIELDS = ["problem", "desired_outcome", "success_criteria", "scope_boundaries"];

export function broadIntentReady(intent, projectId) {
  if (!intent || !nonempty(projectId)) return false;
  const confirmed = new Set(intent.confirmed_fields ?? []);
  const fields = intent.fields ?? {};
  if (!REQUIRED_BROAD_INTENT_FIELDS.every((field) => confirmed.has(field)
    && (nonempty(fields[field]) || (Array.isArray(fields[field]) && fields[field].some(nonempty))))) return false;
  return !(intent.unresolved_questions ?? []).some((question) => question.status !== "answered" && question.status !== "deferred");
}

export function mayCreateJobs(item) {
  return !isBroadIntent(item) || (item.intent.status === "execution_approved" && broadIntentReady(item.intent, item.project_id));
}

export function syncIntentPlan(item, decision, at = now()) {
  if (!isBroadIntent(item)) return;
  item.intent.summary ||= decision.reason;
  item.intent.fields = {
    ...item.intent.fields,
    project_id: decision.project,
    desired_outcome: item.intent.fields.desired_outcome ?? decision.work_items.map((work) => work.outcome).join(" "),
  };
  const previous = new Map((item.intent.work_slices ?? []).map((slice) => [slice.id, slice]));
  item.intent.work_slices = decision.work_items.map((work, index) => {
    const id = `${item.id}:slice:${index + 1}`;
    return { ...previous.get(id), id, sequence: index + 1, title: work.title, outcome: work.outcome,
      acceptance_criteria: copy(work.acceptance_criteria), status: previous.get(id)?.status ?? "planned",
      work_item_id: item.id, job_id: previous.get(id)?.job_id ?? null };
  });
  item.intent.updated_at = at;
}

export function validateOptions(options) {
  if (!Array.isArray(options) || options.length < 2) throw new Error("At least two candidate options are required.");
  const normalized = options.map((option, index) => {
    if (!option || typeof option !== "object" || !nonempty(option.title)) throw new Error("Every option requires a title.");
    const pros = option.pros ?? [];
    const cons = option.cons ?? [];
    if (!Array.isArray(pros) || !Array.isArray(cons) || [...pros, ...cons].some((entry) => !nonempty(entry))) {
      throw new Error("Option pros and cons must be text arrays.");
    }
    return { id: nonempty(option.id) ? option.id.trim() : `option-${index + 1}`, title: option.title.trim(),
      description: nonempty(option.description) ? option.description.trim() : null,
      pros: pros.map((entry) => entry.trim()), cons: cons.map((entry) => entry.trim()) };
  });
  if (new Set(normalized.map((option) => option.id)).size !== normalized.length) throw new Error("Option ids must be unique.");
  return normalized;
}

export function projectCollection(project) {
  project.goals ??= [];
  project.features ??= [];
  project.research_tasks ??= [];
  project.revision ??= 1;
  return project;
}

export function makeGoal(input, actor, at = now()) {
  if (!nonempty(input?.title) || !nonempty(input?.description) || !nonempty(input?.why)) throw new Error("A goal requires title, description, and why.");
  if (input.measurable_target !== undefined && input.measurable_target !== null
    && (!input.measurable_target || typeof input.measurable_target !== "object" || Array.isArray(input.measurable_target)
      || !nonempty(input.measurable_target.metric) || !Number.isFinite(Number(input.measurable_target.value)))) {
    throw new Error("A measurable target requires a metric and numeric value.");
  }
  return { id: nonempty(input.id) ? input.id.trim() : randomUUID(), title: input.title.trim(), description: input.description.trim(),
    why: input.why.trim(), success_criteria: nonempty(input.success_criteria) ? input.success_criteria.trim() : null,
    measurable_target: copy(input.measurable_target ?? null), status: "Active", evidence: [], evaluations: [], progress: null,
    proposed_options: [], next_evaluation_at: null, created_at: at, updated_at: at, created_by: actor };
}

export function makeFeature(input, goals, actor, at = now()) {
  if (!nonempty(input?.title) || !nonempty(input?.description) || !nonempty(input?.why)) throw new Error("A feature requires title, description, and why.");
  if (!COMPLETION_TYPES.includes(input.completion_type)) throw new Error("completion_type must be exactly 'Done when shipped' or 'Done when outcome reached'.");
  const goalIds = Array.isArray(input.goal_ids) ? [...new Set(input.goal_ids.filter(nonempty).map((id) => id.trim()))] : [];
  const known = new Set(goals.map((goal) => goal.id));
  if (goalIds.some((id) => !known.has(id))) throw new Error("Feature references an unknown goal.");
  return { id: nonempty(input.id) ? input.id.trim() : randomUUID(), title: input.title.trim(), description: input.description.trim(), why: input.why.trim(),
    success_criteria: nonempty(input.success_criteria) ? input.success_criteria.trim() : null,
    completion_type: input.completion_type, goal_ids: goalIds, status: "Planned", evidence: [], progress: null,
    work_item_ids: [], proposed_options: [], created_at: at, updated_at: at, created_by: actor };
}
