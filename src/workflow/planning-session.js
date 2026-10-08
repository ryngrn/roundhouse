const itemPlanningStates = new Set(["Imported Pending", "Depot", "Needs Clarification", "Review", "Blocked"]);
const jobPlanningStates = new Set(["Review", "Blocked"]);
const terminalStates = new Set(["Imported History", "Archived", "Reconciled", "Shipped"]);
const readyStates = new Set(["Ready"]);
const activeStates = new Set(["Decision", "Executing", "Verification", "Rework"]);

const maximumTimestamp = "9999-12-31T23:59:59.999Z";

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function priorityRank(item, job) {
  if (Number.isFinite(job?.priority_rank)) return job.priority_rank;
  if (Number.isFinite(item?.priority_rank)) return item.priority_rank;
  return 100;
}

function projectKey(item, job) {
  const assigned = job?.project_id ?? item?.project_id;
  if (assigned) return `assigned:${assigned}`;
  if (item?.project_candidate_id) return `candidate:${item.project_candidate_id}`;
  return "unassigned:~";
}

function recordCreatedAt(item, job) {
  const value = job?.created_at ?? item?.created_at;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : maximumTimestamp;
}

function stateExclusion(state) {
  if (terminalStates.has(state)) return { code: "terminal_state", reason: `${state} records are terminal and cannot enter planning.` };
  if (readyStates.has(state)) return { code: "ready_for_dispatch", reason: "Ready work has crossed the planning boundary and belongs to dispatch." };
  if (activeStates.has(state)) return { code: "active_work", reason: `${state} work is already being triaged or executed.` };
  return { code: "state_not_plannable", reason: `${state ?? "Unknown"} is not a planning-session state.` };
}

function openQuestionSignals(item) {
  return (item.questions ?? [])
    .filter((question) => question.status === "open")
    .map((question) => ({ code: "open_question", question_id: question.id, revision: question.revision ?? null,
      reason: question.prompt ?? "A durable question awaits a human answer." }));
}

function humanNeed(item, job) {
  const signals = openQuestionSignals(item);
  if (job?.human_task && job.human_task.status !== "completed") {
    signals.push({ code: "human_task", revision: job.revision ?? null,
      reason: job.human_task.prompt ?? job.human_task.description ?? "A durable human task is incomplete." });
  }
  if (job?.hold?.requires_review === true) {
    signals.push({ code: "review_hold", reason: job.hold.reason ?? "The durable job hold requires human review." });
  }
  if (job?.reconciliation?.required === true) {
    signals.push({ code: "reconciliation_required", reason: job.reconciliation.reason ?? "External state requires human reconciliation." });
  }
  if (signals.length === 0 && (job?.state ?? item.state) === "Needs Clarification") {
    signals.push({ code: "clarification_state", reason: item.history?.at(-1)?.reason ?? "The item requires clarification." });
  }
  if (signals.length === 0 && (job?.state ?? item.state) === "Review") {
    signals.push({ code: "review_state", reason: job?.history?.at(-1)?.reason ?? item.history?.at(-1)?.reason ?? "The record requires human review." });
  }
  if (signals.length === 0 && (job?.state ?? item.state) === "Blocked") {
    signals.push({ code: "blocked_state", reason: job?.hold?.reason ?? job?.history?.at(-1)?.reason
      ?? item.history?.at(-1)?.reason ?? "The record is blocked and requires inspection before replacement work is planned." });
  }
  return signals;
}

function auditEvidence(job) {
  if (!job) return null;
  const latest = job.attempts?.at(-1) ?? null;
  return {
    disposition: "read_only_provenance",
    attempts_retained: job.attempts?.length ?? 0,
    latest_attempt: latest ? { number: latest.number ?? null, status: latest.status ?? null, failure: latest.failure ?? null } : null,
    delivery_evidence_present: Boolean(job.shipping),
    replay_permitted: false,
    mutation_permitted: false,
    represented_as_delivered: job.state === "Shipped",
  };
}

function sourceRecords(data) {
  const records = [];
  for (const item of Object.values(data.items ?? {})) {
    const jobs = (item.job_ids ?? []).map((id) => data.jobs?.[id]).filter(Boolean);
    if (!jobs.length) records.push({ entity_type: "item", entity: item, item, job: null });
    else for (const job of jobs) records.push({ entity_type: "job", entity: job, item, job });
  }
  return records;
}

function assess(record) {
  const eligible = record.entity_type === "item" ? itemPlanningStates.has(record.entity.state) : jobPlanningStates.has(record.entity.state);
  if (!eligible) return { eligible, ...stateExclusion(record.entity.state) };
  if (record.entity_type === "item") {
    const reasons = {
      "Imported Pending": ["imported_pending", "Imported work requires an authoritative Roundhouse planning decision."],
      Depot: ["unplanned_intake", "Depot intake has not yet crossed the planning boundary."],
      "Needs Clarification": ["human_clarification", "The current durable item state requires human clarification."],
      Review: ["human_review", "The current durable item state requires human review."],
      Blocked: ["blocked_item", "The blocked item may be inspected to plan replacement work; it is not replayable."],
    };
    const [code, reason] = reasons[record.entity.state];
    return { eligible, code, reason };
  }
  return record.entity.state === "Review"
    ? { eligible, code: "human_required_job", reason: "The job has a durable unresolved human requirement." }
    : { eligible, code: "blocked_job", reason: "The failed or blocked job is read-only provenance for planning replacement work." };
}

function projectedRecord(record, eligibility) {
  const { item, job, entity, entity_type: entityType } = record;
  const rank = priorityRank(item, job);
  const key = projectKey(item, job);
  const createdAt = recordCreatedAt(item, job);
  return {
    entity_type: entityType,
    entity_id: entity.id,
    item_id: item.id,
    job_id: job?.id ?? null,
    state: entity.state,
    project_id: job?.project_id ?? item.project_id ?? null,
    project_candidate_id: item.project_candidate_id ?? null,
    priority: item.priority ?? null,
    priority_rank: rank,
    created_at: createdAt === maximumTimestamp ? null : createdAt,
    title: job?.work?.title ?? item.input?.text?.split("\n").find((line) => line.trim())?.trim().slice(0, 160) ?? "Untitled work",
    eligibility: { ...eligibility, human_need: humanNeed(item, job) },
    audit: auditEvidence(job),
    _order: { project: key, priority: rank, created_at: createdAt, item_id: item.id, entity_id: entity.id },
  };
}

function comparator(mode) {
  const fields = mode === "project"
    ? ["project", "priority", "created_at", "item_id", "entity_id"]
    : ["priority", "project", "created_at", "item_id", "entity_id"];
  return (left, right) => {
    for (const field of fields) {
      const difference = typeof left._order[field] === "number"
        ? left._order[field] - right._order[field]
        : compare(left._order[field], right._order[field]);
      if (difference) return difference;
    }
    return 0;
  };
}

function ordering(entry, mode, position) {
  const fields = mode === "project"
    ? ["project", "priority", "created_at", "item_id", "entity_id"]
    : ["priority", "project", "created_at", "item_id", "entity_id"];
  const keys = Object.fromEntries(fields.map((field) => [field, entry._order[field]]));
  return { mode, position, keys, reason: `Position ${position} follows ${mode}-first order using ${fields.join(", ")} as deterministic keys.` };
}

/**
 * Build a pure, read-only planning projection from authoritative durable state.
 * This function never transitions, retries, reconciles, or delivers a record.
 */
export function planningSessionView(data, { mode = "project" } = {}) {
  if (!["project", "priority"].includes(mode)) throw new Error("Planning order mode must be project or priority.");
  const assessed = sourceRecords(data).map((record) => ({ record, eligibility: assess(record) }));
  const entries = assessed.filter(({ eligibility }) => eligibility.eligible)
    .map(({ record, eligibility }) => projectedRecord(record, eligibility))
    .sort(comparator(mode))
    .map((entry, index) => {
      const value = { ...entry, ordering: ordering(entry, mode, index + 1) };
      delete value._order;
      return value;
    });
  const excluded = assessed.filter(({ eligibility }) => !eligibility.eligible)
    .map(({ record, eligibility }) => ({ entity_type: record.entity_type, entity_id: record.entity.id,
      item_id: record.item.id, job_id: record.job?.id ?? null, state: record.entity.state,
      code: eligibility.code, reason: eligibility.reason }));
  return { authority: "durable_roundhouse_state", mode, entries, excluded };
}
