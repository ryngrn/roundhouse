import { displayState } from "./presentation.js";
import { digest } from "../storage/repository.js";

const activeStates = new Set(["Decision", "Executing", "Verification", "Rework"]);
const queuedStates = new Set(["Depot", "Ready", "Imported Pending"]);
const completedStates = new Set(["Shipped", "Imported History", "Archived", "Reconciled"]);

function aggregateState(item, jobs) {
  if (!jobs.length) return item.state;
  if (jobs.every((job) => job.state === "Shipped")) return "Shipped";
  return ["Blocked", "Review", "Rework", "Verification", "Executing", "Ready"].find((state) =>
    jobs.some((job) => job.state === state),
  );
}

export function itemView(data, item) {
  const jobs = item.job_ids.map((id) => data.jobs[id]).filter(Boolean);
  const openQuestions = (item.questions ?? []).filter((question) => question.status === "open");
  const openQuestion = openQuestions[0];
  const state = aggregateState(item, jobs);
  const currentJob = jobs.find((job) => job.state === state);
  const completedJobs = jobs.filter((job) => job.state === "Shipped");
  const blockedJob = jobs.find((job) => job.state === "Blocked");
  const checks = jobs.flatMap((job) => job.shipping?.verification?.checks ?? job.attempts.at(-1)?.verification?.checks ?? []).map((check) => ({
    id: check.id, passed: check.passed, exit_code: check.exit_code, source: check.source ?? "automated",
    ...(check.summary ? { summary: check.summary } : {}),
    ...(check.artifacts?.length ? { artifacts: check.artifacts } : {}),
  }));
  const deliveries = completedJobs.map((job) => ({
    job_id: job.id,
    provider: job.shipping?.provider ?? null,
    commit: job.shipping?.commit ?? null,
    branch: job.shipping?.branch ?? null,
    pushed: job.shipping?.pushed ?? false,
    version: job.shipping?.version ?? null,
    reference: job.shipping?.reference ?? null,
    outputs: job.shipping?.outputs ?? [],
    result: job.shipping?.result ?? null,
    provenance: job.shipping?.provenance ?? null,
    deployment: job.shipping?.deployment ?? null,
    timestamp: job.shipping?.timestamp ?? null,
  }));
  const completionReports = completedJobs.map((job) => job.attempts.at(-1)?.execution?.report).filter(Boolean);
  const completionResults = completedJobs.map((job) => job.shipping?.result).filter((value) => value !== undefined && value !== null);
  const outputs = completedJobs.flatMap((job) => job.shipping?.outputs ?? []);
  const deliveryUrls = deliveries.map((delivery) => delivery.deployment?.url ?? delivery.deployment?.deploy_url).filter(Boolean);
  const importedOutcome = item.legacy_depot?.Outcome || item.legacy_depot?.["Delivery Summary"] || null;
  const outcome = state === "Shipped"
    ? [completionReports.map((report) => report.summary).join(" "),
        `${completedJobs.length} work item${completedJobs.length === 1 ? "" : "s"} verified and shipped by Roundhouse.`,
        deliveryUrls.length ? `Delivery: ${deliveryUrls.join(", ")}` : ""].filter(Boolean).join(" ")
    : state === "Imported History" ? importedOutcome ?? "Imported completed history from the archived Notion Depot."
      : blockedJob ? `Blocked: ${blockedJob.history.at(-1)?.reason ?? "attention required"}` : null;
  const provenance = item.provenance ?? item.legacy_sources?.at(-1) ?? null;
  const legacy = item.legacy_depot ?? item.legacy_depot_records?.at(-1) ?? null;
  const title = legacy?.Item || item.decision?.work_items?.[0]?.title || item.input.text.split("\n").find((line) => line.trim())?.trim().slice(0, 160) || "Untitled work";
  const decidedAcceptance = item.decision?.work_items?.flatMap((work) => work.acceptance_criteria ?? []).map((criterion) => criterion.description) ?? [];
  const acceptance = decidedAcceptance.length ? decidedAcceptance : (legacy?.["Acceptance Criteria"] ? [legacy["Acceptance Criteria"]] : []);
  const answeredQuestions = (item.questions ?? []).filter((question) => question.status === "answered").map((question) => ({
    id: question.id, decision_key: question.decision_key ?? null, prompt: question.prompt, answer: question.answer?.text ?? "",
    answered_at: question.answer?.at ?? question.updated_at ?? null,
  }));
  return {
    id: item.id,
    state,
    revision: item.revision,
    project: item.project_id ?? null,
    project_candidate: item.project_candidate_id ? data.project_candidates?.[item.project_candidate_id] ?? null : null,
    priority: item.priority ?? null,
    title,
    summary: item.input.text.slice(0, 240),
    raw_intake: item.input.text,
    brief: legacy?.["Normalized Brief"] || item.decision?.reason || null,
    context: item.input.context ?? null,
    acceptance_criteria: acceptance,
    reason: currentJob?.history.at(-1)?.reason ?? item.history.at(-1)?.reason ?? null,
    question: openQuestion?.prompt ?? null,
    question_id: openQuestion?.id ?? null,
    question_revision: openQuestion?.revision ?? null,
    questions: openQuestions.map((question) => ({
      id: question.id, decision_id: question.decision_id ?? null, decision_key: question.decision_key ?? null,
      revision: question.revision, kind: question.kind, prompt: question.prompt,
    })),
    needs_you: openQuestions.length > 0,
    display_state: displayState(state, { needsYou: openQuestions.length > 0 }),
    outcome,
    imported: Boolean(provenance?.source_system === "notion"),
    provenance,
    legacy,
    requires_reevaluation: item.requires_reevaluation === true,
    execution_eligible: item.execution_eligible !== false,
    triage: item.triage ? {
      status: item.triage.status ?? null,
      reason: item.triage.reason ?? item.history.at(-1)?.reason ?? null,
      attempts: item.triage.attempts?.length ?? 0,
      next_attempt_at: item.triage.next_attempt_at ?? null,
      last_error: item.triage.last_error ?? null,
    } : null,
    created_at: item.created_at ?? null,
    updated_at: item.updated_at ?? null,
    agent_role: currentJob?.agent_role ?? item.agent_role ?? null,
    owning_node: currentJob?.owning_node ?? item.owning_node ?? data.projects?.[item.project_id]?.owning_node ?? null,
    verification_status: checks.length ? (checks.every((check) => check.passed) ? "Passed" : "Failed") : (state === "Verification" ? "Running" : "Not run"),
    shipping_status: deliveries.length ? (deliveries.every((delivery) => delivery.deployment?.status === "succeeded" || delivery.pushed || delivery.commit) ? "Delivered" : "Pending") : (state === "Shipped" ? "Shipped" : "Not shipped"),
    prior_decisions: answeredQuestions,
    history: (item.history ?? []).map((event) => ({ from: event.from ?? null, to: event.to, reason: event.reason, at: event.at })),
    evidence: { checks, deliveries, completion_reports: completionReports, completion_results: completionResults, outputs },
    jobs: jobs.map((job) => ({
      id: job.id,
      title: job.work.title,
      state: job.state,
      reason: job.history.at(-1)?.reason ?? null,
      attempts: job.attempts.length,
      agent_role: job.agent_role ?? "general",
      shipping: job.shipping ?? null,
      latest_run: job.attempts?.at(-1)?.run ?? null,
      latest_failure: job.attempts?.at(-1)?.failure ?? null,
      reconciliation: job.reconciliation ?? job.attempts?.at(-1)?.run?.reconciliation ?? null,
      allocation: job.allocation ?? null,
      allocation_history: job.allocation_history ?? [],
    })),
  };
}

function dispatchHoldReason(job, data, config) {
  if (job?.state !== "Ready") return null;
  const project = config?.projects?.find((candidate) => candidate.id === job.project_id);
  if (!project) return "Project is missing from the execution configuration.";
  if (project.status !== "active") return "Project is not active.";
  const dependencyId = (job.dependencies ?? []).find((id) => data.jobs?.[id]?.state !== "Shipped");
  if (dependencyId) return `Waiting for prerequisite ${dependencyId} (${data.jobs?.[dependencyId]?.state ?? "missing"}).`;
  const projectState = data.projects?.[job.project_id];
  if (projectState?.blocked) return "Project is blocked by an earlier execution failure.";
  if (projectState?.stop) return "Project was stopped by an operator.";
  if (projectState?.review_required) return "Project needs review approval.";
  if (!["local", "herdr"].includes(project.runtime ?? "local")) return `Configured runtime ${project.runtime} is unavailable.`;
  return null;
}

function reviewFor(entity, dispatchHold = null) {
  if (entity?.state === "Blocked") return { required: true, kind: "blocked",
    reason: entity.history?.at(-1)?.reason ?? "Work is blocked and needs investigation." };
  if (entity?.state === "Needs Clarification") return { required: true, kind: "clarification",
    reason: entity.history?.at(-1)?.reason ?? "An answer is needed before proceeding." };
  if (entity?.state === "Review") return { required: true, kind: "approval",
    reason: entity.history?.at(-1)?.reason ?? "Approval or a decision is required." };
  // A Ready dependency directly behind another Ready job is normal queueing. Any
  // other deterministic hold needs attention and must not be counted as ready.
  if (entity?.state === "Ready" && dispatchHold && !/^Waiting for prerequisite .+ \(Ready\)\.$/.test(dispatchHold)) {
    return { required: true, kind: "blocked", reason: dispatchHold };
  }
  return { required: false, kind: null, reason: null };
}

function projectedJob(data, job, config) {
  const parent = data.items[job.parent_id];
  const parentView = parent ? itemView(data, parent) : {};
  const attempt = job.attempts?.at(-1) ?? {};
  const dispatchHold = dispatchHoldReason(job, data, config);
  const review = reviewFor(job, dispatchHold);
  const shippedOutcome = job.state === "Shipped" ? [
    attempt.execution?.report?.summary,
    "1 work item verified and shipped by Roundhouse.",
    job.shipping?.deployment?.url ?? job.shipping?.deployment?.deploy_url,
  ].filter(Boolean).join(" ") : null;
  const { jobs: _jobs, ...base } = parentView;
  return {
    ...base,
    id: job.id,
    revision: job.revision,
    title: job.work?.title ?? parentView.title ?? job.id,
    state: job.state,
    display_state: displayState(job.state, { needsYou: review.required }),
    needs_you: review.required,
    review_required: review.required,
    review_kind: review.kind,
    review_reason: review.reason,
    project: job.project_id ?? parentView.project ?? null,
    agent_role: job.agent_role ?? parentView.agent_role ?? "general",
    owning_node: job.owning_node ?? job.project_context?.name ?? parentView.owning_node ?? null,
    verification_status: attempt.verification?.passed ? "Passed" : attempt.verification ? "Failed" : (job.state === "Verification" ? "Running" : "Not run"),
    shipping_status: job.shipping ? "Delivered" : "Not shipped",
    updated_at: job.updated_at ?? parentView.updated_at ?? null,
    reason: job.history?.at(-1)?.reason ?? parentView.reason ?? null,
    outcome: shippedOutcome ?? job.work?.outcome ?? parentView.outcome ?? null,
    acceptance_criteria: (job.work?.acceptance_criteria ?? []).map((criterion) => criterion.description ?? criterion),
    evidence: {
      checks: job.shipping?.verification?.checks ?? attempt.verification?.checks ?? [],
      deliveries: job.shipping ? [{ job_id: job.id, ...job.shipping }] : [],
      completion_reports: attempt.execution?.report ? [attempt.execution.report] : [],
      completion_results: job.shipping?.result === undefined ? [] : [job.shipping.result],
      outputs: job.shipping?.outputs ?? [],
    },
    history: (job.history ?? []).map((event) => ({ from: event.from ?? null, to: event.to, reason: event.reason, at: event.at })),
    questions: [],
    issue_resolution: job.issue_resolution ?? null,
    dispatch_hold: dispatchHold,
  };
}

function projectedStandaloneItem(data, item) {
  const projected = itemView(data, item);
  const review = reviewFor(item);
  return {
    ...projected,
    needs_you: review.required,
    review_required: review.required,
    review_kind: review.kind,
    review_reason: review.reason,
  };
}

// This is the one canonical, job-level dashboard projection used by both the
// loopback menu API and the hosted relay. Parent items are projected only when
// they have no jobs, so every visible record has one stable authoritative ID.
export function dashboardProjection(data, config, { connection = {} } = {}) {
  const parentStatus = statusView(data);
  const items = [
    ...Object.values(data.jobs ?? {}).map((job) => projectedJob(data, job, config)),
    ...Object.values(data.items ?? {}).filter((item) => !(item.job_ids ?? []).length)
      .map((item) => projectedStandaloneItem(data, item)),
  ].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || a.id.localeCompare(b.id));
  const counts = {
    needs_review: items.filter((item) => item.review_required).length,
    needs_you: items.filter((item) => item.needs_you).length,
    active: items.filter((item) => activeStates.has(item.state)).length,
    queued: items.filter((item) => queuedStates.has(item.state) && !item.needs_you).length,
    completed: items.filter((item) => completedStates.has(item.state)).length,
    blocked: items.filter((item) => item.state === "Blocked").length,
  };
  const projection_revision = digest(items.map((item) => ({
    id: item.id, revision: item.revision, state: item.state,
    needs_you: item.needs_you, review_kind: item.review_kind,
  }))).slice(0, 24);
  return {
    schema_version: 2,
    projection_revision,
    overview: {
      ...parentStatus,
      projection_revision,
      items,
      counts,
      needs_you: needsHumanView(data).questions,
      connection,
    },
  };
}

export function statusView(data, filters = {}) {
  const items = Object.values(data.items)
    .filter((item) => !filters.item_id || item.id === filters.item_id)
    .filter((item) => !filters.project_id || item.project_id === filters.project_id || item.input.project_hint === filters.project_id)
    .map((item) => itemView(data, item))
    .sort((a, b) => (data.items[a.id].priority_rank ?? 100) - (data.items[b.id].priority_rank ?? 100)
      || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || a.id.localeCompare(b.id));
  const nextJob = Object.values(data.jobs)
    .filter((job) => job.state === "Ready" && job.project_context?.status === "active"
      && !data.projects?.[job.project_id]?.blocked && !data.projects?.[job.project_id]?.stop && !data.projects?.[job.project_id]?.review_required
      && (job.dependencies ?? []).every((id) => data.jobs[id]?.state === "Shipped"))
    .sort((a, b) => (a.priority_rank ?? 100) - (b.priority_rank ?? 100) || (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id))[0];
  const nextItem = nextJob ? data.items[nextJob.parent_id] : null;
  const next_departure = nextJob && nextItem ? {
    item_id: nextItem.id,
    job_id: nextJob.id,
    project_id: nextJob.project_id,
    title: nextJob.work?.title ?? nextItem.input?.text?.slice(0, 160) ?? "Untitled work",
    priority: nextItem.priority ?? null,
  } : null;
  return { items, next_departure, projects: data.projects, project_candidates: data.project_candidates ?? {}, system_metadata: data.system_metadata ?? {} };
}

export function needsHumanView(data, filters = {}) {
  const questions = Object.values(data.items)
    .filter((item) => !filters.item_id || item.id === filters.item_id)
    .filter((item) => !filters.project_id || item.project_id === filters.project_id || item.input.project_hint === filters.project_id)
    .flatMap((item) => (item.questions ?? [])
      .filter((question) => question.status === "open")
      .map((question) => ({
        id: question.id,
        decision_id: question.decision_id,
        revision: question.revision,
        kind: question.kind,
        prompt: question.prompt,
        item_id: item.id,
        item_revision: item.revision,
        project: item.project_id ?? null,
        state: item.state,
      })));
  return { questions };
}

const notificationStates = new Set(["Needs Clarification", "Review", "Blocked", "Shipped", "Archived", "Reconciled"]);

export function notificationView(data, { after } = {}) {
  const events = data.outbox ?? [];
  const index = after ? events.findLastIndex((event) => event.id === after) : -1;
  const start = index + 1;
  const sliced = after && start === 0 ? events : events.slice(start);
  const seen = new Set(events.slice(0, start).map((event) => event.id));
  const notifications = [];
  for (const event of sliced) {
    if (!notificationStates.has(event.state) || seen.has(event.id)) continue;
    seen.add(event.id);
    const item = data.items[event.item_id];
    const entity = data.jobs[event.entity_id] ?? item;
    const kind = ["Needs Clarification", "Review"].includes(event.state) ? "needs_you"
      : event.state === "Blocked" ? "failure" : "completion";
    notifications.push({
      id: event.id,
      kind,
      state: event.state,
      item_id: event.item_id,
      entity_id: event.entity_id,
      title: kind === "needs_you" ? "Roundhouse needs a signal" : kind === "failure" ? "Roundhouse work held up" : "Roundhouse reached the station",
      message: event.reason,
      project: entity?.project_id ?? item?.project_id ?? null,
      at: event.at,
    });
  }
  return { notifications, cursor: events.at(-1)?.id ?? after ?? null };
}
