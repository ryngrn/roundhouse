import { digest } from "../storage/repository.js";

const dimensions = ["paid_tokens", "paid_dollars"];

export function normalizePaidUsage(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(dimensions.map((key) => [key,
    Number.isFinite(source[key]) && source[key] >= 0 ? source[key] : 0]));
}

export function reportedPaidUsage(execution) {
  const source = execution?.usage ?? execution?.output?.usage ?? execution?.report?.usage;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const paid_tokens = source.paid_tokens ?? source.total_tokens;
  const paid_dollars = source.paid_dollars ?? source.cost_usd;
  if (!Number.isFinite(paid_tokens) && !Number.isFinite(paid_dollars)) return null;
  if ((Number.isFinite(paid_tokens) && paid_tokens < 0) || (Number.isFinite(paid_dollars) && paid_dollars < 0)) return null;
  return {
    ...(Number.isFinite(paid_tokens) ? { paid_tokens } : {}),
    ...(Number.isFinite(paid_dollars) ? { paid_dollars } : {}),
  };
}

function accountedUsage(attempt) {
  const estimate = normalizePaidUsage(attempt.paid_usage?.estimate);
  const actual = attempt.paid_usage?.actual;
  return normalizePaidUsage(actual ? { ...estimate, ...actual } : estimate);
}

function totals(data, predicate, excludedJobId) {
  const total = normalizePaidUsage();
  const reservations = [];
  for (const job of Object.values(data.jobs ?? {})) {
    for (const attempt of job.attempts ?? []) {
      if (!predicate(job, attempt)) continue;
      const usage = normalizePaidUsage(accountedUsage(attempt));
      for (const dimension of dimensions) total[dimension] += usage[dimension];
    }
    const pending = job.pre_dispatch_budget;
    if (job.id !== excludedJobId && pending?.status === "reserved" && predicate(job, { run: { provider_id: pending.provider_id } })) {
      const usage = normalizePaidUsage(pending.estimate);
      for (const dimension of dimensions) total[dimension] += usage[dimension];
      reservations.push(job.id);
    }
  }
  return { usage: total, reservations: reservations.sort() };
}

function thresholdStatus(budget, current, estimate) {
  const projected = {};
  const soft_exceeded = [];
  const hard_exceeded = [];
  for (const dimension of dimensions) {
    projected[dimension] = current[dimension] + estimate[dimension];
    const soft = budget?.[`soft_${dimension}`];
    const hard = budget?.[`hard_${dimension}`];
    if (Number.isFinite(soft) && projected[dimension] > soft) soft_exceeded.push(dimension);
    if (Number.isFinite(hard) && projected[dimension] > hard) hard_exceeded.push(dimension);
  }
  return { configured: structuredClone(budget ?? {}), current, projected, soft_exceeded, hard_exceeded };
}

export function evaluatePaidDispatch({ data, project, provider, job, attempt, at = new Date().toISOString() }) {
  const paid = provider?.paid === true;
  const estimate = paid ? normalizePaidUsage(provider.estimate) : normalizePaidUsage();
  const providerTotals = totals(data, (_job, entry) => entry.run?.provider_id === provider?.id, job.id);
  const projectTotals = totals(data, (candidate) => candidate.project_id === project.id, job.id);
  const providerStatus = thresholdStatus(provider?.budget, providerTotals.usage, estimate);
  const projectStatus = thresholdStatus(project.budget, projectTotals.usage, estimate);
  const accounted_reservations = { provider: providerTotals.reservations, project: projectTotals.reservations };
  const hard_exceeded = [
    ...providerStatus.hard_exceeded.map((dimension) => ({ scope: "provider", dimension })),
    ...projectStatus.hard_exceeded.map((dimension) => ({ scope: "project", dimension })),
  ];
  const soft_exceeded = [
    ...providerStatus.soft_exceeded.map((dimension) => ({ scope: "provider", dimension })),
    ...projectStatus.soft_exceeded.map((dimension) => ({ scope: "project", dimension })),
  ];
  const scope = { job_id: job.id, input_digest: job.input_digest, policy_hash: job.policy_hash,
    provider_id: provider?.id ?? null, project_id: project.id, attempt, estimate,
    provider: providerStatus, project: projectStatus, accounted_reservations, hard_exceeded };
  return { version: 1, paid, provider_id: provider?.id ?? null, project_id: project.id, job_id: job.id,
    attempt, estimate, provider: providerStatus, project: projectStatus, accounted_reservations, soft_exceeded, hard_exceeded,
    decision: hard_exceeded.length ? "approval_required" : soft_exceeded.length ? "soft_limit_allowed" : "within_budget",
    scope_digest: digest(scope), recorded_at: at };
}

export function budgetApprovalValid(job, evaluation, item = null) {
  const approval = job.budget_approval;
  const gate = job.budget_gate;
  return Boolean(approval && gate && approval.scope_digest === evaluation.scope_digest
    && gate.scope_digest === evaluation.scope_digest && approval.item_revision === gate.item_revision
    && approval.job_revision === gate.job_revision && approval.job_revision === job.revision
    && (!item || approval.item_revision === item.revision)
    && typeof approval.actor === "string" && approval.actor.trim()
    && typeof approval.approved_at === "string" && !Number.isNaN(Date.parse(approval.approved_at)));
}

export function paidUsageSummary(data) {
  const attempts = Object.values(data.jobs ?? {}).flatMap((job) => job.attempts ?? [])
    .filter((attempt) => attempt.paid_usage?.evaluation?.paid === true);
  const sum = (selector) => attempts.reduce((total, attempt) => {
    const usage = normalizePaidUsage(selector(attempt));
    for (const dimension of dimensions) total[dimension] += usage[dimension];
    return total;
  }, normalizePaidUsage());
  return { attempts: attempts.length, estimated: sum((attempt) => attempt.paid_usage.estimate), accounted: sum(accountedUsage) };
}
