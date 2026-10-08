import { digest } from "./store.js";
import { record } from "./state.js";

// Persist decisions about blocked work without ever implicitly replaying the original
// failed attempt. Both web and CLI write this same authoritative local state.
export function listIssues(data, { projectId } = {}) {
  const items = Object.values(data.items ?? {});
  const jobs = Object.values(data.jobs ?? {});
  const blocked = [
    ...jobs.filter((job) => job.state === "Blocked").map((job) => {
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
    reason: item.history?.at(-1)?.reason || "Blocked work needs investigation.",
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
  issueId, expectedRevision, actor, message, action = "note",
} = {}) {
  if (typeof issueId !== "string" || !issueId.trim()) throw new Error("An issue ID is required.");
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Current issue revision is required.");
  if (typeof actor !== "string" || !actor.trim() || actor.length > 128) throw new Error("Issue actor is required.");
  if (typeof message !== "string" || !message.trim() || message.length > 10000) throw new Error("Issue response needs 1–10,000 characters.");
  if (!["note", "replan"].includes(action)) throw new Error("Unsupported issue action.");
  return store.change((data) => {
    const entity = data.jobs[issueId] ?? data.items[issueId];
    if (!entity || entity.state !== "Blocked") throw new Error("Issue is not currently Blocked.");
    if (entity.revision !== expectedRevision) throw new Error("Stale issue revision; review latest status before responding.");
    entity.issue_resolution ??= { status: "needs_attention", messages: [], follow_up_id: null };
    if (action === "replan" && entity.issue_resolution.follow_up_id) throw new Error("A repair task already exists; review that task before creating another.");
    const timestamp = new Date().toISOString();
    const note = { text: message.trim(), actor: actor.trim(), action, at: timestamp };
    entity.issue_resolution.messages.push(note);
    entity.issue_resolution.status = action === "replan" ? "repair_queued" : "investigating";
    entity.revision += 1; entity.updated_at = timestamp;
    let follow_up_id = null;
    if (action === "replan") {
      const original = data.items[entity.parent_id] ?? entity;
      follow_up_id = digest(`repair:${issueId}`).slice(0, 24);
      if (data.items[follow_up_id]) throw new Error("Repair item already exists; refusing duplicate.");
      const cause = entity.history?.at(-1)?.reason || "Unknown failure";
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
    }
    return { issue_id: issueId, revision: entity.revision, status: entity.issue_resolution.status, follow_up_id };
  });
}
