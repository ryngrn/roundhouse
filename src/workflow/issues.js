import { digest } from "./store.js";
import { record, transition } from "./state.js";
import { hasExecutableAcceptanceCriteria } from "./decision.js";
import { projectContext } from "./config.js";

// Deterministic local preflight; never runs an executor or contacts a paid model.
export function dispatchHoldReason(job, data, config) {
  if (job?.state !== "Ready") return null;
  const project = config?.projects?.find((candidate) => candidate.id === job.project_id);
  if (!project) return "Project is missing from the execution configuration.";
  if (project.status !== "active") return "Project is not active.";
  const deps = (job.dependencies ?? []).filter((id) => data.jobs?.[id]?.state !== "Shipped");
  if (deps.length) {
    const missing = deps[0], dependency = data.jobs?.[missing];
    return `Waiting for prerequisite ${missing} (${dependency?.state ?? "missing"}).`;
  }
  if (data.projects?.[job.project_id]?.blocked) return "Project is blocked by an earlier execution failure.";
  if (data.projects?.[job.project_id]?.stop) return "Project was stopped by an operator.";
  if (data.projects?.[job.project_id]?.review_required) return "Project needs review approval.";
  if (project.runtime !== "local") return `Configured for ${project.runtime}; local Studio dispatcher cannot execute it.`;
  if (!hasExecutableAcceptanceCriteria(job.work, project)) return "Acceptance criteria are not fully mapped to configured verification checks.";
  try {
    if (digest(projectContext(project)) !== job.policy_hash) return "Project policy or context changed after this job was planned.";
  } catch {
    return "Required project context is unavailable.";
  }
  if (!["commit_only", "push_branch"].includes(project.policy?.shipping)) return `No installed shipping adapter for ${project.policy?.shipping}.`;
  return null;
}

// Persist decisions about blocked work without ever implicitly replaying the original
// failed attempt. Both web and CLI write this same authoritative local state.
export function listIssues(data, { projectId, config } = {}) {
  const items = Object.values(data.items ?? {});
  const jobs = Object.values(data.jobs ?? {});
  const blocked = [
    ...jobs.filter((job) => job.state === "Blocked" ||
      (job.state === "Ready" && dispatchHoldReason(job, data, config))).map((job) => {
      const parent = data.items[job.parent_id];
      return { kind: "job", item: job, title: job.work?.title || parent?.input?.text?.slice(0, 90) || job.id };
    }),
    ...items.filter((item) => item.state === "Blocked" && !item.job_ids?.length).map((item) => ({
      kind: "item", item, title: item.input?.text?.split("\n")[0]?.slice(0, 90) || item.id,
    })),
  ];
  return blocked.filter(({ item }) => !projectId || item.project_id === projectId).map(({ kind, item, title }) => ({
    id: item.id, kind, title, project_id: item.project_id || null,
    revision: item.revision,
    status: item.issue_resolution?.status || "needs_attention",
    reason: dispatchHoldReason(item, data, config) ||
      item.history?.at(-1)?.reason || "Blocked work needs investigation.",
    held_ready: item.state === "Ready",
    history: item.issue_resolution?.messages ?? [],
    follow_up_id: item.issue_resolution?.follow_up_id ?? null,
    at: item.updated_at ?? null,
    latest_attempt: kind === "job" ? {
      number: item.attempts?.at(-1)?.number ?? null,
      failure: item.attempts?.at(-1)?.failure ?? null,
      passed_verification: item.attempts?.at(-1)?.verification?.passed === true,
    } : null,
  }));
}

export function respondToIssue(store, {
  issueId, expectedRevision, actor, message, action = "note", config,
} = {}) {
  if (typeof issueId !== "string" || !issueId.trim()) throw new Error("An issue ID is required.");
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Current issue revision is required.");
  if (typeof actor !== "string" || !actor.trim() || actor.length > 128) throw new Error("Issue actor is required.");
  if (typeof message !== "string" || !message.trim() || message.length > 10000) throw new Error("Issue response needs 1–10,000 characters.");
  if (!["note", "replan"].includes(action)) throw new Error("Unsupported issue action.");
  return store.change((data) => {
    const entity = data.jobs[issueId] ?? data.items[issueId];
    const heldReady = entity?.state === "Ready" && dispatchHoldReason(entity, data, config);
    if (!entity || (entity.state !== "Blocked" && !heldReady)) throw new Error("Issue is not currently blocked or held.");
    if (entity.revision !== expectedRevision) throw new Error("Stale issue revision; review latest status before responding.");
    entity.issue_resolution ??= { status: "needs_attention", messages: [], follow_up_id: null };
    if (action === "replan" && entity.issue_resolution.follow_up_id) throw new Error("A repair task already exists; review that task before creating another.");
    const timestamp = new Date().toISOString();
    const originalReason = dispatchHoldReason(entity, data, config) || entity.history?.at(-1)?.reason || "Unknown failure";
    const note = { text: message.trim(), actor: actor.trim(), action, at: timestamp };
    entity.issue_resolution.messages.push(note);
    entity.issue_resolution.status = action === "replan" ? "repair_queued" : "investigating";
    entity.revision += 1; entity.updated_at = timestamp;
    let follow_up_id = null;
    if (action === "replan") {
      const original = data.items[entity.parent_id] ?? entity;
      follow_up_id = digest(`repair:${issueId}`).slice(0, 24);
      if (data.items[follow_up_id]) throw new Error("Repair item already exists; refusing duplicate.");
      const cause = originalReason;
      const title = entity.work?.title || original.input?.text?.slice(0, 120) || "Blocked work";
      const input = {
        text: `Investigate and resolve Roundhouse issue ${issueId}: ${title}\n\nObserved blocker: ${cause}\n\nUser's guidance: ${message.trim()}\n\nDo not replay the blocked job or assume previous work shipped. Inspect recorded attempts and external outcomes first. Produce verifiable acceptance criteria and a safe, separately reviewed repair plan.`,
        source: "issue-resolution",
        actor: actor.trim(),
        ...(entity.project_id ? { project_id: entity.project_id } : {}),
        context: { issue_id: issueId, original_item_id: original.id },
      };
      data.items[follow_up_id] = record(follow_up_id, {
        input, clarifications: [], decision: null, job_ids: [], parent_issue_id: issueId,
      });
      entity.issue_resolution.follow_up_id = follow_up_id;
      if (heldReady) transition(entity, "Blocked", "Superseded by a separately planned repair; never replay automatically.");
    }
    return { issue_id: issueId, revision: entity.revision, status: entity.issue_resolution.status, follow_up_id };
  });
}
