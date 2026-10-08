import { digest } from "../storage/repository.js";

const stableKey = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const absoluteTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function normalizeSchedule(schedule) {
  if (schedule == null) return null;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) throw new Error("Work schedule must be an object or null.");
  const allowed = new Set(["not_before", "recurrence", "wait_for"]);
  for (const key of Object.keys(schedule)) if (!allowed.has(key)) throw new Error(`Unknown work schedule field: ${key}`);

  const notBefore = schedule.not_before == null ? null : timestamp(schedule.not_before, "schedule.not_before");
  const waitFor = schedule.wait_for == null ? null : normalizeCondition(schedule.wait_for);
  const recurrence = schedule.recurrence == null ? null : normalizeRecurrence(schedule.recurrence, notBefore);
  if (waitFor && (notBefore || recurrence)) throw new Error("An external-condition wait cannot also be a time or recurrence wait.");
  if (recurrence && notBefore && recurrence.start_at !== notBefore) {
    throw new Error("schedule.not_before must equal recurrence.start_at when both are supplied.");
  }
  if (!waitFor && !notBefore && !recurrence) return null;
  return { not_before: recurrence?.start_at ?? notBefore, recurrence, wait_for: waitFor };
}

function timestamp(value, field) {
  if (typeof value !== "string" || !absoluteTimestamp.test(value)) {
    throw new Error(`${field} must be an absolute ISO timestamp with a timezone.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an absolute ISO timestamp with a timezone.`);
  return new Date(parsed).toISOString();
}

function normalizeCondition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule.wait_for must be an object.");
  for (const key of Object.keys(value)) if (!["key", "description"].includes(key)) throw new Error(`Unknown condition field: ${key}`);
  if (typeof value.key !== "string" || !stableKey.test(value.key)) throw new Error("schedule.wait_for.key must be a stable lowercase identifier.");
  if (typeof value.description !== "string" || !value.description.trim()) throw new Error("schedule.wait_for.description is required.");
  return { key: value.key, description: value.description.trim() };
}

function normalizeRecurrence(value, notBefore) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule.recurrence must be an object.");
  for (const key of Object.keys(value)) if (!["start_at", "interval_seconds", "max_occurrences", "end_at"].includes(key)) throw new Error(`Unknown recurrence field: ${key}`);
  if (value.start_at == null && notBefore == null) throw new Error("schedule.recurrence.start_at is required.");
  const startAt = timestamp(value.start_at ?? notBefore, "schedule.recurrence.start_at");
  if (!Number.isSafeInteger(value.interval_seconds) || value.interval_seconds < 1) throw new Error("schedule.recurrence.interval_seconds must be a positive integer.");
  if (value.max_occurrences != null && (!Number.isSafeInteger(value.max_occurrences) || value.max_occurrences < 1)) {
    throw new Error("schedule.recurrence.max_occurrences must be a positive integer or null.");
  }
  const endAt = value.end_at == null ? null : timestamp(value.end_at, "schedule.recurrence.end_at");
  if (endAt && Date.parse(endAt) < Date.parse(startAt)) throw new Error("schedule.recurrence.end_at cannot precede start_at.");
  return { start_at: startAt, interval_seconds: value.interval_seconds,
    max_occurrences: value.max_occurrences ?? null, end_at: endAt };
}

export function initializeJobSchedule(job, schedule, conditions = {}, { now = Date.now() } = {}) {
  const normalized = normalizeSchedule(schedule, { now });
  if (!normalized) return job;
  const at = new Date(now).toISOString();
  if (normalized.wait_for) {
    const signal = conditions[normalized.wait_for.key];
    const satisfied = signal?.satisfied === true;
    job.eligibility = {
      kind: "condition", status: satisfied ? "eligible" : "waiting", eligible_at: satisfied ? at : null,
      condition: normalized.wait_for, signal_revision: signal?.revision ?? null,
      transitions: [{ from: null, to: satisfied ? "eligible" : "waiting", at,
        reason: satisfied ? `Condition ${normalized.wait_for.key} was already satisfied.` : `Waiting for external condition ${normalized.wait_for.key}.` }],
    };
    return job;
  }
  const eligibleAt = normalized.not_before;
  const occurrence = 1;
  if (normalized.recurrence) {
    job.recurrence = { ...normalized.recurrence, occurrence, series_id: digest({ parent_id: job.parent_id, position: job.position,
      start_at: normalized.recurrence.start_at, interval_seconds: normalized.recurrence.interval_seconds }).slice(0, 32) };
    job.occurrence_key = `${job.recurrence.series_id}:${occurrence}`;
  }
  const waiting = Date.parse(eligibleAt) > now;
  job.eligibility = { kind: "time", status: waiting ? "waiting" : "eligible", eligible_at: eligibleAt, condition: null,
    transitions: [{ from: null, to: waiting ? "waiting" : "eligible", at,
      reason: waiting ? `Scheduled for ${eligibleAt}.` : `Scheduled timestamp ${eligibleAt} is due.` }] };
  return job;
}

export function assessJobEligibility(job, conditions = {}, { now = Date.now(), mutate = false } = {}) {
  if (!job.eligibility) return { eligible: true, reason: "No time or external-condition wait is declared.", code: "immediate" };
  if (job.eligibility.kind === "time") {
    const eligible = Date.parse(job.eligibility.eligible_at) <= now;
    if (eligible && mutate && job.eligibility.status !== "eligible") transitionEligibility(job, "eligible", `Scheduled timestamp ${job.eligibility.eligible_at} became due.`, now);
    return { eligible, code: eligible ? "time_due" : "time_wait", eligible_at: job.eligibility.eligible_at,
      reason: eligible ? `Scheduled timestamp ${job.eligibility.eligible_at} is due.` : `Waiting until ${job.eligibility.eligible_at}.` };
  }
  const key = job.eligibility.condition?.key;
  const signal = conditions[key];
  const eligible = signal?.satisfied === true;
  if (eligible && mutate && job.eligibility.status !== "eligible") {
    job.eligibility.signal_revision = signal.revision;
    transitionEligibility(job, "eligible", `External condition ${key} was satisfied.`, now);
  }
  return { eligible, code: eligible ? "condition_satisfied" : "condition_wait", condition_key: key,
    signal_revision: signal?.revision ?? null,
    reason: eligible ? `External condition ${key} is satisfied.` : `Waiting for external condition ${key}.` };
}

function transitionEligibility(job, to, reason, now) {
  const from = job.eligibility.status;
  job.eligibility.status = to;
  job.eligibility.transitions ??= [];
  job.eligibility.transitions.push({ from, to, reason, at: new Date(now).toISOString() });
}

export function recordConditionSignal(data, key, { satisfied, actor, details = null, at = Date.now() }) {
  if (typeof key !== "string" || !stableKey.test(key)) throw new Error("Condition key must be a stable lowercase identifier.");
  if (typeof satisfied !== "boolean") throw new Error("Condition signal requires a boolean satisfied value.");
  if (typeof actor !== "string" || !actor.trim()) throw new Error("Condition signal requires an actor.");
  data.system_metadata ??= {};
  data.system_metadata.condition_signals ??= {};
  const previous = data.system_metadata.condition_signals[key];
  const signal = { key, satisfied, revision: (previous?.revision ?? 0) + 1, actor: actor.trim(), details,
    observed_at: new Date(at).toISOString() };
  data.system_metadata.condition_signals[key] = signal;
  for (const job of Object.values(data.jobs ?? {})) {
    if (job.state !== "Ready" || job.eligibility?.kind !== "condition" || job.eligibility.condition?.key !== key) continue;
    if (satisfied) {
      job.eligibility.signal_revision = signal.revision;
      if (job.eligibility.status !== "eligible") transitionEligibility(job, "eligible", `External condition ${key} was satisfied by ${actor}.`, at);
    } else if (job.eligibility.status === "eligible" && !job.attempts?.length) {
      job.eligibility.signal_revision = signal.revision;
      transitionEligibility(job, "waiting", `External condition ${key} is no longer satisfied.`, at);
    }
  }
  return signal;
}

export function nextOccurrence(job, { position, now = Date.now() } = {}) {
  if (!job.recurrence) return null;
  const occurrence = job.recurrence.occurrence + 1;
  if (job.recurrence.max_occurrences != null && occurrence > job.recurrence.max_occurrences) return null;
  const eligibleAt = new Date(Date.parse(job.recurrence.start_at) + ((occurrence - 1) * job.recurrence.interval_seconds * 1000)).toISOString();
  if (job.recurrence.end_at && Date.parse(eligibleAt) > Date.parse(job.recurrence.end_at)) return null;
  const id = `${job.id.replace(/-occurrence-\d+$/, "")}-occurrence-${occurrence}`;
  const next = {
    ...structuredClone(job), id, revision: 1, state: "Ready", position, created_at: new Date(now).toISOString(), updated_at: undefined,
    history: [], attempts: [], processes: [], prepared: undefined, shipping: undefined, delivery_intent: undefined, reconciliation: undefined,
    provider_evidence: job.provider_evidence ? { ...structuredClone(job.provider_evidence), invoked: null, invoked_at: undefined } : undefined,
    provider_transitions: [],
    owning_node_id: null, owning_node: null,
    recurrence: { ...job.recurrence, occurrence }, occurrence_key: `${job.recurrence.series_id}:${occurrence}`,
    eligibility: { kind: "time", status: Date.parse(eligibleAt) > now ? "waiting" : "eligible", eligible_at: eligibleAt, condition: null,
      transitions: [{ from: null, to: Date.parse(eligibleAt) > now ? "waiting" : "eligible", at: new Date(now).toISOString(),
        reason: Date.parse(eligibleAt) > now ? `Recurring occurrence ${occurrence} is scheduled for ${eligibleAt}.` : `Recurring occurrence ${occurrence} is due.` }] },
  };
  return next;
}

export function ensureNextOccurrence(data, job, { now = Date.now() } = {}) {
  const candidate = nextOccurrence(job, { position: Object.keys(data.jobs ?? {}).length, now });
  if (!candidate) return { successor: null, created: false };
  const existing = Object.values(data.jobs ?? {}).find((entry) => entry.occurrence_key === candidate.occurrence_key);
  if (existing) return { successor: existing, created: false };
  if (data.jobs[candidate.id]) throw new Error(`Recurring occurrence ID collision: ${candidate.id}`);
  const parent = data.items?.[job.parent_id];
  if (!parent) throw new Error(`Recurring work has no parent item: ${job.parent_id}`);
  data.jobs[candidate.id] = candidate;
  parent.job_ids ??= [];
  if (!parent.job_ids.includes(candidate.id)) parent.job_ids.push(candidate.id);
  return { successor: candidate, created: true };
}

export function nextScheduledWake(data, { now = Date.now() } = {}) {
  const timestamps = Object.values(data.jobs ?? {})
    .filter((job) => job.state === "Ready" && job.eligibility?.kind === "time" && Date.parse(job.eligibility.eligible_at) > now)
    .map((job) => job.eligibility.eligible_at).sort();
  return timestamps[0] ?? null;
}
