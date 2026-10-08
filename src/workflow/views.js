import { displayState } from "./presentation.js";
import { assessJobEligibility } from "./scheduling.js";

const activeJobStates = new Set(["Executing", "Verification", "Rework"]);

function matchesFilters(item, filters) {
  return (!filters.item_id || item.id === filters.item_id)
    && (!filters.project_id || item.project_id === filters.project_id || item.input.project_id === filters.project_id || item.input.project_hint === filters.project_id)
    && (!filters.source || item.input.source === filters.source)
    && (!filters.thread_id || item.input.thread_id === filters.thread_id)
    && (!filters.correlation_id || item.input.correlation_id === filters.correlation_id);
}

function remoteRunIdentity(remoteExecution) {
  if (!remoteExecution) return null;
  return remoteExecution.execution_id ?? remoteExecution.run_id ?? remoteExecution.remote_run_id ?? null;
}

function jobView(job) {
  const attempt = job.attempts?.at(-1) ?? null;
  const remoteExecution = attempt?.execution?.remote_execution ?? job.remote_execution ?? null;
  const configuredHerdr = job.project_context?.herdr ?? null;
  const runtime = remoteExecution?.runtime ?? job.project_context?.runtime ?? "local";
  return {
    id: job.id,
    job_id: job.id,
    item_id: job.parent_id,
    project: job.project_id,
    project_id: job.project_id,
    title: job.work?.title ?? "Untitled work",
    state: job.state,
    active: activeJobStates.has(job.state),
    display_state: displayState(job.state),
    reason: job.history?.at(-1)?.reason ?? null,
    attempts: job.attempts?.length ?? 0,
    latest_run: attempt?.run ?? null,
    latest_failure: attempt?.failure ?? null,
    provider_evidence: job.provider_evidence ?? attempt?.provider_evidence ?? null,
    latest_attempt_provider: attempt?.provider_evidence ?? null,
    provider_transitions: job.provider_transitions ?? [],
    reconciliation: job.reconciliation ?? job.delivery_intent?.reconciliation ?? attempt?.run?.reconciliation ?? null,
    agent_role: job.agent_role ?? "general",
    runtime,
    machine: remoteExecution?.machine_selector ?? configuredHerdr?.machine ?? null,
    agent: remoteExecution?.agent_target ?? configuredHerdr?.agent ?? null,
    workspace_mode: remoteExecution?.workspace_mode ?? configuredHerdr?.workspace_mode ?? (runtime === "herdr" ? "shared_worktree" : null),
    working_directory: remoteExecution?.working_directory ?? configuredHerdr?.working_directory ?? null,
    remote_run_id: remoteRunIdentity(remoteExecution),
    remote_execution: remoteExecution,
    owning_node: job.owning_node ?? null,
    shipping: job.shipping ?? null,
    eligibility: job.eligibility ?? null,
    recurrence: job.recurrence ?? null,
    occurrence_key: job.occurrence_key ?? null,
    action_policy: job.action_policy ?? null,
    human_task: job.human_task ?? null,
  };
}

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
  const pendingHumanTasks = jobs.filter((job) => job.human_task && job.human_task.status !== "completed");
  const openQuestion = openQuestions[0];
  const state = aggregateState(item, jobs);
  const currentJob = jobs.find((job) => job.state === state);
  const waitingJob = jobs.find((job) => job.state === "Ready"
    && !assessJobEligibility(job, data.system_metadata?.condition_signals ?? {}).eligible);
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
  const completionResults = completedJobs.map((job) => job.shipping?.result).filter(Boolean);
  const deliveryUrls = deliveries.map((delivery) => delivery.deployment?.url ?? delivery.deployment?.deploy_url).filter(Boolean);
  const importedOutcome = item.legacy_depot?.Outcome || item.legacy_depot?.["Delivery Summary"] || null;
  const outcome = state === "Shipped"
    ? [completionReports.map((report) => report.summary).join(" "),
        completionResults.map((result) => result.summary).filter(Boolean).join(" "),
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
  const allocationDecisions = data.system_metadata?.execution_scheduler?.decisions ?? [];
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
    decision_provider: item.decision?.provider_evidence ?? item.triage?.attempts?.at(-1)?.provider_evidence ?? null,
    decision_provider_transitions: item.provider_transitions ?? [],
    context: item.input.context ?? null,
    acceptance_criteria: acceptance,
    reason: waitingJob ? assessJobEligibility(waitingJob, data.system_metadata?.condition_signals ?? {}).reason
      : currentJob?.history.at(-1)?.reason ?? item.history.at(-1)?.reason ?? null,
    question: openQuestion?.prompt ?? null,
    question_id: openQuestion?.id ?? null,
    question_revision: openQuestion?.revision ?? null,
    questions: openQuestions.map((question) => ({
      id: question.id, decision_id: question.decision_id ?? null, decision_key: question.decision_key ?? null,
      revision: question.revision, kind: question.kind, prompt: question.prompt,
    })),
    needs_you: openQuestions.length > 0 || pendingHumanTasks.length > 0,
    display_state: displayState(state, { needsYou: openQuestions.length > 0 || pendingHumanTasks.length > 0, waiting: waitingJob?.eligibility.kind ?? false }),
    human_tasks: jobs.filter((job) => job.human_task).map((job) => ({ job_id: job.id, revision: job.revision, ...job.human_task })),
    waiting: waitingJob ? {
      kind: waitingJob.eligibility.kind,
      status: waitingJob.eligibility.status,
      eligible_at: waitingJob.eligibility.eligible_at ?? null,
      condition: waitingJob.eligibility.condition ?? null,
      transitions: waitingJob.eligibility.transitions ?? [],
    } : null,
    outcome,
    imported: Boolean(provenance?.source_system === "notion"),
    provenance,
    legacy,
    requires_reevaluation: item.requires_reevaluation === true,
    execution_eligible: item.execution_eligible !== false,
    dispatch_eligible: !waitingJob && item.execution_eligible !== false,
    execution_ineligibility_reasons: item.execution_ineligibility_reasons ?? [],
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
    shipping_status: deliveries.length ? (deliveries.every((delivery) => delivery.deployment?.status === "succeeded" || delivery.pushed || delivery.commit || delivery.reference) ? "Delivered" : "Pending") : (state === "Shipped" ? "Shipped" : "Not shipped"),
    prior_decisions: answeredQuestions,
    history: (item.history ?? []).map((event) => ({ from: event.from ?? null, to: event.to, reason: event.reason, at: event.at })),
    evidence: { checks, deliveries, completion_reports: completionReports, completion_results: completionResults,
      outputs: deliveries.flatMap((delivery) => delivery.outputs.map((output) => ({ ...output,
        reference: `${delivery.reference}/${encodeURIComponent(output.path)}` }))) },
    jobs: jobs.map((job) => ({
      ...jobView(job),
      allocation: allocationDecisions.findLast((decision) => decision.job_id === job.id) ?? null,
      allocation_history: allocationDecisions.filter((decision) => decision.job_id === job.id),
    })),
  };
}

export function statusView(data, filters = {}, executionActivity = null) {
  const items = Object.values(data.items)
    .filter((item) => matchesFilters(item, filters))
    .map((item) => itemView(data, item))
    .sort((a, b) => (data.items[a.id].priority_rank ?? 100) - (data.items[b.id].priority_rank ?? 100)
      || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || a.id.localeCompare(b.id));
  const visibleItemIds = new Set(items.map((item) => item.id));
  const nextJob = Object.values(data.jobs)
    .filter((job) => job.state === "Ready" && job.project_context?.status === "active"
      && !data.projects?.[job.project_id]?.blocked && !data.projects?.[job.project_id]?.stop && !data.projects?.[job.project_id]?.review_required
      && (job.dependencies ?? []).every((id) => data.jobs[id]?.state === "Shipped")
      && assessJobEligibility(job, data.system_metadata?.condition_signals ?? {}).eligible)
    .sort((a, b) => (a.priority_rank ?? 100) - (b.priority_rank ?? 100) || (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id))[0];
  const nextItem = nextJob ? data.items[nextJob.parent_id] : null;
  const next_departure = nextJob && nextItem ? {
    item_id: nextItem.id,
    job_id: nextJob.id,
    project_id: nextJob.project_id,
    title: nextJob.work?.title ?? nextItem.input?.text?.slice(0, 160) ?? "Untitled work",
    priority: nextItem.priority ?? null,
  } : null;
  const scheduler = data.system_metadata?.execution_scheduler;
  const decisions = (scheduler?.decisions ?? [])
    .filter((decision) => !filters.project_id || decision.project_id === filters.project_id)
    .filter((decision) => !filters.item_id || data.jobs[decision.job_id]?.parent_id === filters.item_id);
  const active_jobs = Object.values(data.jobs)
    .filter((job) => activeJobStates.has(job.state))
    .filter((job) => !filters.source && !filters.thread_id && !filters.correlation_id || visibleItemIds.has(job.parent_id))
    .filter((job) => !filters.project_id || job.project_id === filters.project_id)
    .filter((job) => !filters.item_id || job.parent_id === filters.item_id)
    .map(jobView)
    .sort((a, b) => String(a.project_id).localeCompare(String(b.project_id)) || a.job_id.localeCompare(b.job_id));
  return {
    items,
    active_jobs,
    untracked_activity: Object.keys(filters).length ? [] : executionActivity?.activity ?? [],
    activity_inspection: executionActivity ? {
      checked_at: executionActivity.checked_at,
      process_inspection: executionActivity.process_inspection,
      worktree_inspection: executionActivity.worktree_inspection,
      warnings: executionActivity.warnings,
    } : { checked_at: null, process_inspection: "not_requested", worktree_inspection: "not_requested", warnings: [] },
    next_departure,
    allocations: {
      capacity: scheduler?.capacity ?? null,
      allocation_sequence: scheduler?.sequence ?? 0,
      decision_sequence: scheduler?.decision_sequence ?? 0,
      latest: Object.fromEntries(Object.entries(scheduler?.latest ?? {})
        .filter(([projectId]) => !filters.project_id || projectId === filters.project_id)
        .filter(([, decision]) => !filters.item_id || data.jobs[decision.job_id]?.parent_id === filters.item_id)),
      decisions,
    },
    projects: data.projects,
    project_candidates: data.project_candidates ?? {},
    system_metadata: data.system_metadata ?? {},
  };
}

export function needsHumanView(data, filters = {}) {
  const questions = Object.values(data.items)
    .filter((item) => matchesFilters(item, filters))
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
