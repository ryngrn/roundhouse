import pg from "pg";
import { randomUUID } from "node:crypto";
import { digest } from "./store.js";
import { projectContext } from "./config.js";
import { Engine } from "./engine.js";

const { Pool } = pg;
let pool;
let relayReady;

const RELAY_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS roundhouse_relay;
CREATE TABLE IF NOT EXISTS roundhouse_relay.dashboard_projection (
  id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS roundhouse_relay.remote_commands (
  id uuid PRIMARY KEY, kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, result jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), claimed_at timestamptz, finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS remote_commands_queue_idx
  ON roundhouse_relay.remote_commands (status,created_at,id);
`;

function relaySsl(connectionString) {
  const url = new URL(connectionString);
  const ca = process.env.ROUNDHOUSE_RELAY_CA_CERT?.replaceAll("\\n", "\n");
  if (ca) return { rejectUnauthorized: true, ca };
  if (url.searchParams.get("sslmode") === "require") return { rejectUnauthorized: false };
  return { rejectUnauthorized: process.env.ROUNDHOUSE_RELAY_ALLOW_INSECURE_TLS !== "1" };
}

export function relayPool(connectionString = process.env.ROUNDHOUSE_RELAY_DATABASE_URL || process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("Roundhouse relay is not configured.");
  if (!pool) {
    const parsed = new URL(connectionString);
    const ssl = relaySsl(connectionString);
    parsed.searchParams.delete("sslmode");
    parsed.searchParams.delete("uselibpqcompat");
    pool = new Pool({
      connectionString: parsed.toString(),
      ssl,
      max: 1,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 5000,
      query_timeout: 15000,
      application_name: "roundhouse:studio-relay",
    });
    pool.on("error", () => {});
  }
  return pool;
}

export async function ensureRelay({ query = (...args) => relayPool().query(...args) } = {}) {
  if (!relayReady) relayReady = query(RELAY_SCHEMA).catch((error) => { relayReady = null; throw error; });
  await relayReady;
}

function activeProject(config, id) {
  const project = config.projects.find((candidate) => candidate.id === id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  return projectContext(project);
}

function note(entity, reason) {
  const at = new Date().toISOString();
  entity.revision += 1;
  entity.updated_at = at;
  entity.history.push({ from: entity.state, to: entity.state, reason, at });
}

function ensureRevision(entity, expected) {
  if (!entity) throw new Error("Work item not found.");
  if (!Number.isInteger(expected) || expected < 1) throw new Error("Command requires the current item revision.");
  if (entity.revision !== expected) throw new Error(`Stale work item revision. Current revision is ${entity.revision}.`);
}

function findEntity(data, id) {
  if (data.items[id]) return { kind: "item", entity: data.items[id] };
  if (data.jobs[id]) return { kind: "job", entity: data.jobs[id] };
  return null;
}

function assignJob(data, job, project) {
  if (["Executing", "Verification", "Rework", "Shipped"].includes(job.state)) throw new Error("Work in flight or shipped cannot be reassigned.");
  job.project_id = project.id;
  job.project_context = project;
  job.policy_hash = digest(project);
  job.position = Math.max(0, ...Object.values(data.jobs).filter((candidate) => candidate.project_id === project.id).map((candidate) => candidate.position ?? 0)) + 1;
  note(job, `Assigned to ${project.name}.`);
}

function assignItem(data, item, project) {
  if (item.job_ids.length) {
    const jobs = item.job_ids.map((id) => data.jobs[id]).filter(Boolean);
    for (const job of jobs) assignJob(data, job, project);
  }
  item.selected_project = project.id;
  item.project_id = project.id;
  item.project_context = project;
  item.policy_hash = digest(project);
  note(item, `Assigned to ${project.name}.`);
}

function projectHint(payload) {
  const values = [payload.name, payload.repository, ...(payload.context_sources ?? [])].filter((value) => typeof value === "string" && value.trim());
  return values[0]?.trim() || payload.hint || "New Project";
}

export async function applyRemoteCommand({ store, config, command, engine = new Engine({ store, config }) }) {
  const payload = command.payload ?? {};
  if (command.kind === "intake") {
    const item = store.submit({
      text: payload.content,
      source: "remote-dashboard",
      actor: "remote-dashboard",
      ...(payload.project_hint ? { project_id: payload.project_hint } : {}),
    }, payload.idempotency_key ?? `remote:${command.id}`);
    return { item_id: item.id, revision: item.revision };
  }
  if (command.kind === "project_create") {
    return store.change((data) => {
      data.project_requests ??= {};
      const id = payload.idempotency_key ?? `remote-project:${command.id}`;
      data.project_requests[id] ??= {
        id, status: "requested", hint: projectHint(payload), name: payload.name ?? null,
        purpose: payload.purpose ?? null, success_state: payload.success_state ?? null,
        repository: payload.repository ?? null, context_sources: payload.context_sources ?? [],
        created_at: new Date().toISOString(),
      };
      return data.project_requests[id];
    });
  }
  if (command.kind === "project_assign") {
    return store.change((data) => {
      const found = findEntity(data, payload.item_id);
      ensureRevision(found?.entity, payload.expected_item_revision);
      if (payload.project_id) {
        const project = activeProject(config, payload.project_id);
        if (found.kind === "job") assignJob(data, found.entity, project);
        else assignItem(data, found.entity, project);
        return { item_id: payload.item_id, project_id: project.id, revision: found.entity.revision };
      }
      data.project_assignments ??= {};
      const requestId = `assignment:${command.id}`;
      data.project_assignments[requestId] = {
        id: requestId, item_id: payload.item_id, project_hint: payload.project_hint,
        status: "needs_project_configuration", created_at: new Date().toISOString(),
      };
      note(found.entity, `Requested project assignment: ${payload.project_hint}.`);
      return data.project_assignments[requestId];
    });
  }
  if (command.kind === "jump_front") {
    return store.change((data) => {
      const found = findEntity(data, payload.item_id);
      ensureRevision(found?.entity, payload.expected_item_revision);
      const jobs = found.kind === "job" ? [found.entity] : found.entity.job_ids.map((id) => data.jobs[id]).filter((job) => job?.state === "Ready");
      if (!jobs.length) throw new Error("Only Ready work can jump to the front of the line.");
      for (const job of jobs) {
        if (job.state !== "Ready") throw new Error("Only Ready work can jump to the front of the line.");
        const min = Math.min(0, ...Object.values(data.jobs).filter((candidate) => candidate.project_id === job.project_id).map((candidate) => candidate.position ?? 0));
        job.position = min - 1;
        note(job, "Moved to the front of the line.");
      }
      if (found.kind === "item") note(found.entity, "Moved ready work to the front of the line.");
      return { item_id: payload.item_id, job_ids: jobs.map((job) => job.id) };
    });
  }
  if (command.kind === "decision_session") {
    const answers = payload.answers ?? [];
    if (!Array.isArray(answers) || !answers.length) throw new Error("Decision session is incomplete.");
    const text = answers.map((answer) => `${answer.question_id}: ${answer.answer}`).join("\n\n");
    const item = engine.clarify(payload.item_id, text, "remote-dashboard", payload.project_id);
    return { item_id: item.id, revision: item.revision };
  }
  throw new Error(`Unsupported remote command: ${command.kind}`);
}

function latestAttempt(job) {
  return job.attempts?.at(-1) ?? {};
}

function questionFor(entity) {
  if (!["Needs Clarification", "Review"].includes(entity.state)) return [];
  const prompt = entity.decision?.question || entity.history.at(-1)?.reason || "What should Roundhouse know before continuing?";
  return [{ id: `${entity.id}:decision`, prompt, revision: entity.revision }];
}

function workItemFromJob(job, data) {
  const parent = data.items[job.parent_id];
  const attempt = latestAttempt(job);
  return {
    id: job.id,
    revision: job.revision,
    title: job.work?.title || parent?.input?.context?.title || parent?.input?.text?.slice(0, 80) || job.id,
    state: job.state,
    display_state: job.state,
    needs_you: ["Needs Clarification", "Review"].includes(job.state),
    project: job.project_id ?? null,
    priority: parent?.input?.priority || "P2",
    agent_role: parent?.decision?.executor || job.project_context?.executor?.kind || "Executor",
    owning_node: job.project_context?.name || job.project_id || "Roundhouse",
    verification_status: attempt.verification?.passed ? "Passed" : attempt.verification ? "Failed" : "Not run",
    shipping_status: job.shipping ? "Delivered" : "Not shipped",
    updated_at: job.updated_at,
    reason: job.history.at(-1)?.reason ?? "",
    outcome: job.work?.outcome || parent?.input?.context?.outcome || "",
    brief: parent?.input?.text || "",
    summary: job.work?.outcome || parent?.input?.text || "",
    context: parent?.input?.context?.content || "",
    acceptance_criteria: (job.work?.acceptance_criteria ?? []).map((criterion) => criterion.description ?? criterion),
    raw_intake: parent?.input?.text || "",
    legacy: null,
    imported: Boolean(parent?.input?.source?.startsWith("notion")),
    provenance: { source: parent?.input?.source ?? null, source_id: parent?.input?.source ?? null, source_page_url: parent?.input?.source?.startsWith("http") ? parent.input.source : null },
    evidence: { checks: attempt.verification?.checks ?? [], deliveries: job.shipping ? [job.shipping] : [] },
    prior_decisions: parent?.decision_history ?? [],
    history: job.history,
    questions: questionFor(job),
  };
}

function workItemFromItem(item) {
  return {
    id: item.id,
    revision: item.revision,
    title: item.input?.context?.title || item.input?.text?.slice(0, 80) || item.id,
    state: item.state,
    display_state: item.state,
    needs_you: ["Needs Clarification", "Review"].includes(item.state),
    project: item.project_id ?? item.selected_project ?? item.input?.project_id ?? null,
    priority: item.input?.priority || "P2",
    agent_role: item.decision?.executor || "Decision",
    owning_node: item.project_context?.name || item.project_id || "Roundhouse",
    verification_status: "Not run",
    shipping_status: item.completed_at ? "Delivered" : "Not shipped",
    updated_at: item.updated_at,
    reason: item.history.at(-1)?.reason ?? "",
    outcome: item.input?.context?.outcome || item.decision?.reason || "",
    brief: item.input?.text || "",
    summary: item.input?.text || "",
    context: item.input?.context?.content || "",
    acceptance_criteria: item.input?.context?.acceptance_criteria ?? [],
    raw_intake: item.input?.text || "",
    legacy: null,
    imported: Boolean(item.input?.source?.startsWith("notion")),
    provenance: { source: item.input?.source ?? null, source_id: item.input?.source ?? null, source_page_url: item.input?.source?.startsWith("http") ? item.input.source : null },
    evidence: { checks: [], deliveries: [] },
    prior_decisions: item.decision_history ?? [],
    history: item.history,
    questions: questionFor(item),
  };
}

export function dashboardProjection(data, config, { connection = {} } = {}) {
  const items = [
    ...Object.values(data.jobs).map((job) => workItemFromJob(job, data)),
    ...Object.values(data.items).filter((item) => !item.job_ids?.length).map(workItemFromItem),
  ].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const counts = {
    needs_you: items.filter((item) => item.needs_you).length,
    active: items.filter((item) => ["Decision", "Executing", "Verification", "Rework"].includes(item.state)).length,
    queued: items.filter((item) => ["Depot", "Ready", "Imported Pending"].includes(item.state) && !item.needs_you).length,
    completed: items.filter((item) => ["Shipped", "Imported History", "Archived", "Reconciled"].includes(item.state)).length,
    blocked: items.filter((item) => item.state === "Blocked").length,
  };
  const projectCandidates = {};
  for (const request of Object.values(data.project_requests ?? {})) {
    projectCandidates[request.id] = { id: request.id, name: request.name || request.hint || "New Project" };
  }
  for (const assignment of Object.values(data.project_assignments ?? {})) {
    projectCandidates[assignment.id] = { id: assignment.id, name: assignment.project_hint };
  }
  return {
    configuration: { projects: config.projects.map(({ context, ...project }) => project) },
    overview: {
      connection: {
        worker: { running: false },
        storage: { kind: "local", node: { name: process.env.ROUNDHOUSE_NODE_NAME || "Studio" } },
        ...connection,
      },
      counts,
      items,
      project_candidates: projectCandidates,
    },
  };
}

export async function publishDashboardProjection({ store, config, query = (...args) => relayPool().query(...args) }) {
  await ensureRelay({ query });
  const payload = dashboardProjection(store.read(), config);
  const result = await query(`
    INSERT INTO roundhouse_relay.dashboard_projection(id,revision,payload)
    VALUES ('current',1,$1)
    ON CONFLICT (id) DO UPDATE SET
      revision=roundhouse_relay.dashboard_projection.revision + 1,
      updated_at=clock_timestamp(),
      payload=EXCLUDED.payload
    RETURNING revision,updated_at
  `, [payload]);
  return { revision: Number(result.rows[0].revision), updated_at: result.rows[0].updated_at };
}

export async function claimRemoteCommand({ client }) {
  const result = await client.query(`
    UPDATE roundhouse_relay.remote_commands
    SET status='processing', claimed_at=clock_timestamp(), error=NULL
    WHERE id = (
      SELECT id FROM roundhouse_relay.remote_commands
      WHERE status='queued'
      ORDER BY created_at,id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id,kind,payload
  `);
  return result.rows[0] ?? null;
}

export async function processRemoteCommands({ store, config, limit = 25, pool: providedPool = relayPool() } = {}) {
  await ensureRelay({ query: (...args) => providedPool.query(...args) });
  const processed = [];
  for (let index = 0; index < limit; index += 1) {
    const client = await providedPool.connect();
    let command;
    try {
      await client.query("BEGIN");
      command = await claimRemoteCommand({ client });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (!command) break;
    try {
      const result = await applyRemoteCommand({ store, config, command });
      await providedPool.query("UPDATE roundhouse_relay.remote_commands SET status='completed', result=$2, finished_at=clock_timestamp() WHERE id=$1", [command.id, result ?? {}]);
      processed.push({ id: command.id, kind: command.kind, status: "completed", result });
    } catch (error) {
      await providedPool.query("UPDATE roundhouse_relay.remote_commands SET status='failed', error=$2, finished_at=clock_timestamp() WHERE id=$1", [command.id, error.message]);
      processed.push({ id: command.id, kind: command.kind, status: "failed", error: error.message });
    }
  }
  const projection = await publishDashboardProjection({ store, config, query: (...args) => providedPool.query(...args) });
  return { processed, projection };
}

export async function watchRemoteCommands({
  store,
  config,
  subscribeUrl = process.env.ROUNDHOUSE_WAKE_SUBSCRIBE_URL,
  fetchImpl = globalThis.fetch,
  sync = () => processRemoteCommands({ store, config }),
  onSync = () => {},
  heartbeatMs = 60 * 60 * 1000,
} = {}) {
  if (!subscribeUrl) throw new Error("ROUNDHOUSE_WAKE_SUBSCRIBE_URL is not configured.");
  let syncTail = Promise.resolve();
  const syncOnce = () => {
    syncTail = syncTail.then(sync).then(onSync, async (error) => onSync({ error: error.message }));
    return syncTail;
  };
  const timer = heartbeatMs > 0 ? setInterval(syncOnce, heartbeatMs) : null;
  timer?.unref?.();
  try {
    await syncOnce();
    const response = await fetchImpl(subscribeUrl);
    if (!response.ok || !response.body) throw new Error(`Wake subscription failed (${response.status}).`);
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event.event || event.event === "message") await syncOnce();
      }
    }
  } finally {
    if (timer) clearInterval(timer);
  }
  return { stopped: true };
}

export function remoteCommand(kind, payload = {}) {
  return { id: randomUUID(), kind, payload };
}
