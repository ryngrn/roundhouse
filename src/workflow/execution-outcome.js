export const executionOutcomeClassifications = Object.freeze([
  "native_success",
  "recovered_success",
  "exception_success",
  "failed_or_abandoned",
]);

export const executionPathKinds = Object.freeze([
  "local_codex",
  "local_claude",
  "herdr_codex",
  "herdr_claude",
  "local_command",
  "herdr_command",
  "manual_rdc",
  "direct_local_shell",
  "operator_reconciliation",
  "human_task",
  "other",
]);

export const executionExceptionReasons = Object.freeze([
  "stale_worker",
  "missing_capability",
  "provider_limit",
  "herdr_failure",
  "remote_completion_evidence_missing",
  "repository_lock",
  "credential_config_gap",
  "unsupported_action",
  "human_only_action",
  "control_plane_bug",
  "other",
]);

export const nativeProvenanceStages = Object.freeze([
  "intake",
  "dispatch",
  "executor_ownership",
  "verification",
  "delivery",
]);

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const validDate = (value) => nonempty(value) && !Number.isNaN(Date.parse(value));

function validateEvidenceLinks(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  for (const [index, link] of value.entries()) {
    if (!object(link) || !nonempty(link.uri)) throw new Error(`${label}[${index}].uri must be a nonempty string.`);
    if (link.label !== undefined && !nonempty(link.label)) throw new Error(`${label}[${index}].label must be nonempty when supplied.`);
    if (link.kind !== undefined && !nonempty(link.kind)) throw new Error(`${label}[${index}].kind must be nonempty when supplied.`);
  }
}

function validateProvenance(provenance, classification) {
  if (!object(provenance)) throw new Error("execution_outcome.provenance must be an object.");
  for (const [stage, evidence] of Object.entries(provenance)) {
    if (!nativeProvenanceStages.includes(stage)) throw new Error(`Unknown execution provenance stage: ${stage}.`);
    if (!object(evidence)) throw new Error(`execution_outcome.provenance.${stage} must be an object.`);
    if (!validDate(evidence.recorded_at)) throw new Error(`execution_outcome.provenance.${stage}.recorded_at must be an ISO timestamp.`);
    validateEvidenceLinks(evidence.evidence_links, `execution_outcome.provenance.${stage}.evidence_links`);
    if (evidence.evidence_links.length === 0) throw new Error(`execution_outcome.provenance.${stage} requires durable evidence.`);
  }
  if (classification === "native_success") {
    const missing = nativeProvenanceStages.filter((stage) => !provenance[stage]);
    if (missing.length) throw new Error(`native_success requires complete Roundhouse provenance: missing ${missing.join(", ")}.`);
  }
}

/**
 * Validate and clone the durable terminal outcome contract. This deliberately
 * does not derive success from job.state: Shipped is presentation state, not
 * proof that intake, dispatch, execution, verification, and delivery occurred.
 */
export function validateExecutionOutcome(value, { job } = {}) {
  if (!object(value)) throw new Error("execution_outcome must be an object.");
  value = structuredClone(value);
  value.human_minutes ??= null;
  if (value.schema_version !== 1) throw new Error("execution_outcome.schema_version must be 1.");
  if (!executionOutcomeClassifications.includes(value.classification)) throw new Error("Unknown execution outcome classification.");
  if (!validDate(value.recorded_at)) throw new Error("execution_outcome.recorded_at must be an ISO timestamp.");
  if (!nonempty(value.recorded_by)) throw new Error("execution_outcome.recorded_by must be nonempty.");
  if (typeof value.historical_import !== "boolean") throw new Error("execution_outcome.historical_import must be boolean.");

  if (!Array.isArray(value.execution_path) || value.execution_path.length === 0) {
    throw new Error("execution_outcome.execution_path must contain the actual path used.");
  }
  for (const [index, component] of value.execution_path.entries()) {
    if (!object(component) || !executionPathKinds.includes(component.kind)) {
      throw new Error(`execution_outcome.execution_path[${index}].kind is unsupported.`);
    }
    for (const field of ["provider", "runtime", "machine", "detail"]) {
      if (component[field] !== undefined && !nonempty(component[field])) throw new Error(`execution_outcome.execution_path[${index}].${field} must be nonempty when supplied.`);
    }
    if (component.evidence_links !== undefined) validateEvidenceLinks(component.evidence_links, `execution_outcome.execution_path[${index}].evidence_links`);
  }

  validateProvenance(value.provenance, value.classification);
  validateEvidenceLinks(value.evidence_links, "execution_outcome.evidence_links");

  if (typeof value.human_intervention_required !== "boolean") throw new Error("execution_outcome.human_intervention_required must be boolean.");
  if (!Number.isInteger(value.human_intervention_count) || value.human_intervention_count < 0) {
    throw new Error("execution_outcome.human_intervention_count must be a nonnegative integer.");
  }
  if (value.human_intervention_required !== (value.human_intervention_count > 0)) {
    throw new Error("human_intervention_required must agree with human_intervention_count.");
  }
  if (value.human_minutes !== null && (!Number.isFinite(value.human_minutes) || value.human_minutes < 0)) {
    throw new Error("execution_outcome.human_minutes must be null or a nonnegative number.");
  }

  const reasonRequired = ["recovered_success", "exception_success", "failed_or_abandoned"].includes(value.classification);
  if (reasonRequired) {
    if (!object(value.reason) || !executionExceptionReasons.includes(value.reason.code) || !nonempty(value.reason.note)) {
      throw new Error(`${value.classification} requires a structured reason code and freeform note.`);
    }
  } else if (value.reason !== null) throw new Error("native_success cannot have an exception reason.");

  if (value.classification === "exception_success") {
    if (typeof value.exception_expected !== "boolean") throw new Error("exception_success must record whether the exception was expected.");
  } else if (value.exception_expected !== null) {
    throw new Error("exception_expected applies only to exception_success.");
  }
  if (value.classification === "native_success") {
    if (value.historical_import) throw new Error("Historical imported work cannot be native_success.");
    if (value.human_intervention_required) throw new Error("native_success cannot require human intervention.");
  }
  if (job) {
    const completed = ["native_success", "recovered_success", "exception_success"].includes(value.classification);
    if (completed && job.state !== "Shipped") throw new Error(`${value.classification} requires a Shipped job.`);
    if (value.classification === "failed_or_abandoned" && !["Blocked", "Archived"].includes(job.state)) {
      throw new Error("failed_or_abandoned requires a terminal unsuccessful job state.");
    }
  }

  return value;
}

export function executionOutcomeMetricStatus(job) {
  if (job?.execution_outcome_exclusion === "historical_import" || job?.execution_outcome?.historical_import === true) {
    return { eligible: false, reason: "historical_import", classification: null };
  }
  if (!job?.execution_outcome) return { eligible: false, reason: "unclassified", classification: null };
  const outcome = validateExecutionOutcome(job.execution_outcome, { job });
  return { eligible: true, reason: null, classification: outcome.classification };
}

const link = (job, suffix, kind = "state") => ({ kind, uri: `roundhouse://job/${encodeURIComponent(job.id)}/${suffix}` });

function provenanceEvidence(recordedAt, evidenceLink) {
  return { recorded_at: recordedAt, evidence_links: [evidenceLink] };
}

function executionPath(job, attempt) {
  if (job.human_task?.completion) return [{ kind: "human_task", detail: "Authorized human task completion." }];
  const explicit = job.untracked_path_evidence?.execution_path ?? job.exception_completion?.execution_path;
  if (Array.isArray(explicit) && explicit.length) return structuredClone(explicit);
  if (!attempt?.run) return [{ kind: "other", detail: "Roundhouse stopped before executor ownership was established." }];
  const runtime = attempt?.execution?.remote_execution?.runtime ?? job.project_context?.runtime ?? "local";
  const executor = job.project_context?.executor?.kind ?? attempt?.provider_evidence?.invoked?.kind
    ?? attempt?.provider_evidence?.selected?.kind ?? "command";
  const suffix = executor === "codex" ? "codex" : executor === "claude" ? "claude" : "command";
  const kind = `${runtime === "herdr" ? "herdr" : "local"}_${suffix}`;
  const remote = attempt?.execution?.remote_execution;
  return [{ kind, provider: attempt?.run?.provider_id ?? attempt?.provider_evidence?.invoked?.id
    ?? attempt?.provider_evidence?.selected?.id ?? "unclaimed", runtime,
  ...(remote?.machine_selector ?? job.project_context?.herdr?.machine
    ? { machine: remote?.machine_selector ?? job.project_context.herdr.machine } : {}) }];
}

function reasonCode(job, attempt) {
  const text = [job.hold?.code, job.hold?.reason, job.reconciliation?.reason, attempt?.provider_failure?.category,
    attempt?.failure].filter(Boolean).join(" ").toLowerCase();
  if (/stale|expired|interrupt/.test(text)) return "stale_worker";
  if (/repository.*lock|lock.*repository/.test(text)) return "repository_lock";
  if (/credential|configuration|config gap|authentication|permission denied/.test(text)) return "credential_config_gap";
  if (/capabilit|unavailable_dependency/.test(text)) return "missing_capability";
  if (/quota|rate.?limit|provider.?limit|capacity/.test(text)) return "provider_limit";
  if (/remote.*evidence|reconciliation_required|reconcile.*remote|externally_uncertain/.test(text)) return "remote_completion_evidence_missing";
  if (/unsupported|not implemented/.test(text)) return "unsupported_action";
  if (/herdr/.test(text) || (job.project_context?.runtime === "herdr" && attempt?.failure)) return "herdr_failure";
  if (/control.?plane|transaction|lease ownership/.test(text)) return "control_plane_bug";
  return "other";
}

function exceptionEvidence(job) {
  return job.untracked_path_evidence ?? job.exception_completion ?? null;
}

/**
 * Derive a terminal outcome only from durable lifecycle records. Returning null
 * is intentional: an old or incomplete Shipped record is not evidence of a
 * native execution path and must remain outside trustworthy success metrics.
 */
export function deriveExecutionOutcome(job, item, { recordedBy = "roundhouse" } = {}) {
  if (!object(job) || !["Shipped", "Blocked", "Archived"].includes(job.state)) return null;
  if (job.execution_outcome_exclusion === "historical_import") return null;
  const attempt = job.attempts?.at(-1) ?? null;
  const shipping = job.shipping ?? null;
  const exception = exceptionEvidence(job);
  const humanCompletion = job.human_task?.completion ?? null;
  const recovered = job.reconciliation?.status === "confirmed"
    || attempt?.run?.reconciliation?.status === "confirmed"
    || job.recovery?.status === "confirmed";
  const successful = job.state === "Shipped";
  const recordedAt = shipping?.timestamp ?? humanCompletion?.completed_at ?? job.reconciliation?.confirmed_at
    ?? attempt?.finished_at ?? job.updated_at;
  if (!validDate(recordedAt)) return null;

  const provenance = {};
  if (item?.input && validDate(item.created_at)) provenance.intake = provenanceEvidence(item.created_at, link(job, "intake"));
  const dispatch = job.history?.find((event) => event.to === "Executing");
  if (dispatch && validDate(dispatch.at) && attempt?.started_at) provenance.dispatch = provenanceEvidence(dispatch.at, link(job, `attempt/${attempt.number}/dispatch`));
  const invoked = attempt?.provider_evidence?.invoked;
  if (attempt?.run?.id && invoked?.id && validDate(attempt.provider_evidence.invoked_at ?? attempt.started_at)) {
    provenance.executor_ownership = provenanceEvidence(attempt.provider_evidence.invoked_at ?? attempt.started_at,
      link(job, `attempt/${attempt.number}/executor`));
  }
  const verification = attempt?.verification ?? shipping?.verification;
  if (verification?.passed === true && validDate(verification.at ?? recordedAt)) {
    provenance.verification = provenanceEvidence(verification.at ?? recordedAt, link(job, `attempt/${attempt?.number ?? 1}/verification`, "verification"));
  }
  const deliveryConfirmed = shipping && (humanCompletion || exception || recovered
    || job.delivery_intent?.reconciliation?.status === "confirmed");
  if (deliveryConfirmed) provenance.delivery = provenanceEvidence(shipping.timestamp ?? recordedAt, link(job, "delivery", "delivery"));

  let classification;
  let reason = null;
  let expected = null;
  let interventions = 0;
  let humanMinutes = null;
  let path = executionPath(job, attempt);
  if (!successful) {
    classification = "failed_or_abandoned";
    reason = { code: reasonCode(job, attempt), note: job.hold?.reason ?? attempt?.failure
      ?? job.history?.at(-1)?.reason ?? "The attempted outcome was not completed." };
  } else if (humanCompletion || exception) {
    classification = "exception_success";
    const suppliedReason = exception?.reason;
    reason = suppliedReason && executionExceptionReasons.includes(suppliedReason.code) && nonempty(suppliedReason.note)
      ? structuredClone(suppliedReason)
      : { code: humanCompletion ? "human_only_action" : reasonCode(job, attempt),
          note: humanCompletion?.summary ?? exception?.note ?? "Completion used a recorded path outside autonomous Roundhouse execution." };
    expected = exception?.expected ?? Boolean(humanCompletion);
    interventions = exception?.human_intervention_count ?? 1;
    humanMinutes = exception?.human_minutes ?? null;
  } else if (recovered) {
    classification = "recovered_success";
    reason = { code: reasonCode(job, attempt), note: job.reconciliation?.reason ?? job.recovery?.reason
      ?? "Roundhouse reconciled an interrupted attempt against durable completion evidence." };
    path = [...path, { kind: "operator_reconciliation", evidence_links: [link(job, "reconciliation")] }];
    interventions = job.reconciliation?.human_intervention_count ?? job.recovery?.human_intervention_count ?? 1;
    humanMinutes = job.reconciliation?.human_minutes ?? job.recovery?.human_minutes ?? null;
  } else if (nativeProvenanceStages.every((stage) => provenance[stage])) {
    classification = "native_success";
  } else return null;

  return validateExecutionOutcome({ schema_version: 1, classification, recorded_at: recordedAt, recorded_by: recordedBy,
    historical_import: false, execution_path: path, provenance, reason, exception_expected: expected,
    human_intervention_required: interventions > 0, human_intervention_count: interventions, human_minutes: humanMinutes,
    evidence_links: Object.values(provenance).flatMap((entry) => entry.evidence_links) }, { job });
}
