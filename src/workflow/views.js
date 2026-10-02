function aggregateState(item, jobs) {
  if (!jobs.length) return item.state;
  if (jobs.every((job) => job.state === "Shipped")) return "Shipped";
  return ["Blocked", "Review", "Rework", "Verification", "Executing", "Ready"].find((state) =>
    jobs.some((job) => job.state === state),
  );
}

export function itemView(data, item) {
  const jobs = item.job_ids.map((id) => data.jobs[id]).filter(Boolean);
  const openQuestion = (item.questions ?? []).findLast((question) => question.status === "open");
  const state = aggregateState(item, jobs);
  const currentJob = jobs.find((job) => job.state === state);
  const completedJobs = jobs.filter((job) => job.state === "Shipped");
  const blockedJob = jobs.find((job) => job.state === "Blocked");
  const checks = completedJobs.flatMap((job) => job.shipping?.verification?.checks ?? []).map((check) => ({
    id: check.id, passed: check.passed, exit_code: check.exit_code, source: check.source ?? "automated",
    ...(check.summary ? { summary: check.summary } : {}),
    ...(check.artifacts?.length ? { artifacts: check.artifacts } : {}),
  }));
  const deliveries = completedJobs.map((job) => ({
    job_id: job.id,
    commit: job.shipping?.commit ?? null,
    branch: job.shipping?.branch ?? null,
    pushed: job.shipping?.pushed ?? false,
    deployment: job.shipping?.deployment ?? null,
    timestamp: job.shipping?.timestamp ?? null,
  }));
  const completionReports = completedJobs.map((job) => job.attempts.at(-1)?.execution?.report).filter(Boolean);
  const deliveryUrls = deliveries.map((delivery) => delivery.deployment?.url ?? delivery.deployment?.deploy_url).filter(Boolean);
  const outcome = state === "Shipped"
    ? [completionReports.map((report) => report.summary).join(" "),
        `${completedJobs.length} work item${completedJobs.length === 1 ? "" : "s"} verified and shipped by Roundhouse.`,
        deliveryUrls.length ? `Delivery: ${deliveryUrls.join(", ")}` : ""].filter(Boolean).join(" ")
    : blockedJob ? `Blocked: ${blockedJob.history.at(-1)?.reason ?? "attention required"}` : null;
  return {
    id: item.id,
    state,
    revision: item.revision,
    project: item.project_id ?? null,
    summary: item.input.text.slice(0, 240),
    reason: currentJob?.history.at(-1)?.reason ?? item.history.at(-1)?.reason ?? null,
    question: openQuestion?.prompt ?? null,
    question_id: openQuestion?.id ?? null,
    question_revision: openQuestion?.revision ?? null,
    outcome,
    evidence: { checks, deliveries, completion_reports: completionReports },
    jobs: jobs.map((job) => ({
      id: job.id,
      title: job.work.title,
      state: job.state,
      reason: job.history.at(-1)?.reason ?? null,
      attempts: job.attempts.length,
      agent_role: job.agent_role ?? "general",
      shipping: job.shipping ?? null,
    })),
  };
}

export function statusView(data, filters = {}) {
  const items = Object.values(data.items)
    .filter((item) => !filters.item_id || item.id === filters.item_id)
    .filter((item) => !filters.project_id || item.project_id === filters.project_id || item.input.project_hint === filters.project_id)
    .map((item) => itemView(data, item));
  return { items, projects: data.projects };
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

const notificationStates = new Set(["Needs Clarification", "Review", "Blocked", "Shipped"]);

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
      title: kind === "needs_you" ? "Roundhouse needs you" : kind === "failure" ? "Roundhouse work blocked" : "Roundhouse work shipped",
      message: event.reason,
      project: entity?.project_id ?? item?.project_id ?? null,
      at: event.at,
    });
  }
  return { notifications, cursor: events.at(-1)?.id ?? after ?? null };
}
