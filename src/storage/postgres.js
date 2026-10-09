import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { StorageRepository, digest } from "./repository.js";
import { record, transition } from "../workflow/state.js";
import { reservationAssessment } from "../workflow/scheduler.js";
import { initialIntent, rawIdeaEvidence } from "../workflow/intent-program.js";

const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = [
  { version: 1, name: "control_plane", file: path.join(here, "migrations", "001_control_plane.sql") },
  { version: 2, name: "mcp_event_state", file: path.join(here, "migrations", "002_mcp_event_state.sql") },
  { version: 3, name: "durable_item_revisions", file: path.join(here, "migrations", "003_durable_item_revisions.sql") },
  { version: 4, name: "attempt_node_identity", file: path.join(here, "migrations", "004_attempt_node_identity.sql") },
  { version: 5, name: "remote_commands", file: path.join(here, "migrations", "005_remote_commands.sql") },
];
const snapshotLock = 714_209_533;

function emptySnapshot() {
  return { schema_version: 1, items: {}, jobs: {}, projects: {}, project_candidates: {}, system_metadata: {}, outbox: [] };
}

function date(value, fallback = new Date().toISOString()) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function databaseTls(connectionString, allowInsecure) {
  const url = new URL(connectionString);
  if (allowInsecure || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return undefined;
  return { rejectUnauthorized: true, ...(process.env.ROUNDHOUSE_AUTHORITY_CA_CERT_FILE ? { ca: fs.readFileSync(process.env.ROUNDHOUSE_AUTHORITY_CA_CERT_FILE, "utf8") } : {}) };
}

async function rows(client, sql, parameters = []) {
  return (await client.query(sql, parameters)).rows;
}

async function tx(pool, fn) {
  const client = await pool.connect();
  if (process.env.ROUNDHOUSE_DB_DIAGNOSTICS) {
    const originalQuery = client.query.bind(client);
    client.query = async (...args) => {
      try { return await originalQuery(...args); }
      catch (error) { console.error("DB diagnostic:", String(args[0]).slice(0, 145), "code:", error.code, "detail:", error.detail); throw error; }
    };
  }
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function readSnapshot(client) {
  const data = emptySnapshot();
  for (const row of await rows(client, "SELECT key, value FROM roundhouse.system_metadata")) data.system_metadata[row.key] = row.value;
  for (const row of await rows(client, "SELECT id, payload FROM roundhouse.projects ORDER BY id")) data.projects[row.id] = row.payload;
  for (const row of await rows(client, "SELECT id, payload FROM roundhouse.project_candidates ORDER BY id")) data.project_candidates[row.id] = row.payload;
  for (const row of await rows(client, "SELECT id, payload FROM roundhouse.depot_items ORDER BY created_at, id")) data.items[row.id] = row.payload;
  for (const row of await rows(client, `SELECT j.id,j.payload,j.owning_node_id,n.name AS owning_node_name,n.capabilities AS owning_node_capabilities
    FROM roundhouse.jobs j LEFT JOIN roundhouse.nodes n ON n.id=j.owning_node_id ORDER BY j.position,j.id`)) {
    data.jobs[row.id] = { ...row.payload, owning_node_id: row.owning_node_id ?? null,
      owning_node: row.owning_node_name ?? null,
      owning_node_identity: row.owning_node_id ? { id: row.owning_node_id, name: row.owning_node_name, capabilities: row.owning_node_capabilities ?? [] } : null };
  }
  data.outbox = (await rows(client, "SELECT payload FROM roundhouse.outbox_events ORDER BY sequence")).map((row) => row.payload);
  const subscriptions = await rows(client, "SELECT id, payload FROM roundhouse.mcp_subscriptions ORDER BY id");
  const deliveries = await rows(client, "SELECT id, payload FROM roundhouse.mcp_deliveries ORDER BY id");
  if (subscriptions.length || deliveries.length) {
    data.mcp_events = {
      subscriptions: Object.fromEntries(subscriptions.map((row) => [row.id, row.payload])),
      deliveries: Object.fromEntries(deliveries.map((row) => [row.id, row.payload])),
    };
  }
  for (const row of await rows(client, "SELECT key, value FROM roundhouse.mcp_event_state")) {
    data.mcp_events ??= { subscriptions: {}, deliveries: {} };
    data.mcp_events[row.key] = row.value;
  }
  return data;
}

function changedEntries(before = {}, after = {}) {
  return Object.entries(after).filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value));
}

function removedKeys(before = {}, after = {}) {
  return Object.keys(before).filter((key) => !(key in after));
}

async function writeProject(client, id, project) {
    await client.query(`INSERT INTO roundhouse.projects
      (id, name, status, last_commit, stopped, blocked, active, revision, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,last_commit=EXCLUDED.last_commit,
        stopped=EXCLUDED.stopped,blocked=EXCLUDED.blocked,active=EXCLUDED.active,revision=EXCLUDED.revision,
        payload=EXCLUDED.payload,updated_at=clock_timestamp()`, [id, project.name ?? null, project.status ?? null, project.last_commit ?? null,
    Boolean(project.stop), Boolean(project.blocked), Boolean(project.active), project.revision ?? 1, { ...project, id }]);
}

async function writeCandidate(client, id, candidate) {
    await client.query(`INSERT INTO roundhouse.project_candidates
      (id, name, status, executable, source_system, record_count, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,executable=EXCLUDED.executable,
        source_system=EXCLUDED.source_system,record_count=EXCLUDED.record_count,payload=EXCLUDED.payload,updated_at=clock_timestamp()`,
    [id, candidate.name, candidate.status, Boolean(candidate.executable), candidate.source_system ?? null, candidate.record_count ?? 0,
      { ...candidate, id }]);
}

async function writeItem(client, id, item) {
    await client.query(`INSERT INTO roundhouse.depot_items
      (id,state,revision,project_id,project_candidate_id,priority_rank,execution_eligible,requires_reevaluation,input_text,input_source,input_actor,payload,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,revision=EXCLUDED.revision,project_id=EXCLUDED.project_id,
        project_candidate_id=EXCLUDED.project_candidate_id,priority_rank=EXCLUDED.priority_rank,execution_eligible=EXCLUDED.execution_eligible,
        requires_reevaluation=EXCLUDED.requires_reevaluation,input_text=EXCLUDED.input_text,input_source=EXCLUDED.input_source,
        input_actor=EXCLUDED.input_actor,payload=EXCLUDED.payload,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at`, [id, item.state, item.revision, item.project_id ?? null,
      item.project_candidate_id ?? null, Number.isFinite(item.priority_rank) ? item.priority_rank : null, item.execution_eligible !== false,
      Boolean(item.requires_reevaluation), item.input?.text ?? "", item.input?.source ?? null, item.input?.actor ?? null, { ...item, id },
      date(item.created_at), date(item.updated_at, date(item.created_at))]);
    await client.query(`INSERT INTO roundhouse.depot_item_revisions(item_id,revision,state,recorded_at,payload)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (item_id,revision) DO NOTHING`,
    [id, item.revision, item.state, date(item.updated_at, date(item.created_at)), { ...item, id }]);

    await client.query("DELETE FROM roundhouse.decisions WHERE item_id=$1", [id]);
    await client.query("DELETE FROM roundhouse.questions WHERE item_id=$1", [id]);
    await client.query("DELETE FROM roundhouse.import_provenance WHERE item_id=$1", [id]);
    await client.query("DELETE FROM roundhouse.transition_audit WHERE entity_type='item' AND entity_id=$1", [id]);

    const decisionHistory = [...(item.decision_history ?? []), ...(item.decision ? [item.decision] : [])];
    for (let index = 0; index < decisionHistory.length; index += 1) {
      const decision = decisionHistory[index];
      const decisionId = index === decisionHistory.length - 1 && item.decision_id ? item.decision_id : `${id}:decision:${index + 1}`;
      await client.query(`INSERT INTO roundhouse.decisions(id,item_id,item_revision,decision_key,disposition,body,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [decisionId, id, item.revision, decision.decision_key ?? item.decision_key ?? null,
        decision.decision ?? null, decision, date(decision.created_at, date(item.updated_at, date(item.created_at)))]);
    }
    for (const question of item.questions ?? []) {
      await client.query(`INSERT INTO roundhouse.questions
        (id,item_id,decision_id,decision_key,item_revision,revision,kind,prompt,status,created_at,updated_at,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [question.id, id, question.decision_id ?? null,
        question.decision_key ?? null, question.item_revision ?? item.revision, question.revision, question.kind, question.prompt, question.status,
        date(question.created_at), date(question.updated_at, date(question.created_at)), question]);
      if (question.answer) await client.query(`INSERT INTO roundhouse.answers(question_id,text,actor,answered_at,payload) VALUES ($1,$2,$3,$4,$5)`,
        [question.id, question.answer.text, question.answer.actor, date(question.answer.at), question.answer]);
    }
    const provenances = [item.provenance, ...(item.legacy_sources ?? [])].filter((entry) => entry?.source_system && entry?.source_id);
    for (const provenance of provenances) await client.query(`INSERT INTO roundhouse.import_provenance
      (item_id,source_system,source_id,source_page_url,source_record_digest,export_digest,imported_at,reconciled,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, provenance.source_system,
      provenance.source_id, provenance.source_page_url ?? null, provenance.source_record_digest ?? null, provenance.export_digest ?? null,
      date(provenance.imported_at, date(item.created_at)), Boolean(provenance.reconciled), provenance]);
    for (let index = 0; index < (item.history ?? []).length; index += 1) {
      const event = item.history[index];
      await client.query(`INSERT INTO roundhouse.transition_audit(entity_type,entity_id,revision,from_state,to_state,reason,occurred_at)
        VALUES ('item',$1,$2,$3,$4,$5,$6)`, [id, index + 1, event.from ?? null, event.to, event.reason ?? null, date(event.at)]);
    }
}

async function writeJob(client, id, job) {
    await client.query(`INSERT INTO roundhouse.jobs
      (id,item_id,project_id,state,revision,position,agent_role,policy_hash,delivery_intent,payload,created_at,updated_at,owning_node_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET item_id=EXCLUDED.item_id,project_id=EXCLUDED.project_id,state=EXCLUDED.state,
        revision=EXCLUDED.revision,position=EXCLUDED.position,agent_role=EXCLUDED.agent_role,policy_hash=EXCLUDED.policy_hash,
        delivery_intent=EXCLUDED.delivery_intent,payload=EXCLUDED.payload,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,
        owning_node_id=EXCLUDED.owning_node_id`, [id, job.parent_id, job.project_id, job.state, job.revision,
      job.position ?? 0, job.agent_role ?? "general", job.policy_hash ?? null, job.delivery_intent ?? null, job, date(job.created_at), date(job.updated_at, date(job.created_at)),
      job.owning_node_id ?? null]);
    await client.query("DELETE FROM roundhouse.job_dependencies WHERE job_id=$1", [id]);
    await client.query("DELETE FROM roundhouse.agent_role_refs WHERE job_id=$1", [id]);
    await client.query("DELETE FROM roundhouse.job_attempts WHERE job_id=$1", [id]);
    await client.query("DELETE FROM roundhouse.shipping_records WHERE job_id=$1", [id]);
    await client.query("DELETE FROM roundhouse.deployments WHERE job_id=$1", [id]);
    await client.query("DELETE FROM roundhouse.transition_audit WHERE entity_type='job' AND entity_id=$1", [id]);
    for (const dependency of job.dependencies ?? []) await client.query(
      "INSERT INTO roundhouse.job_dependencies(job_id,depends_on_job_id) VALUES ($1,$2)", [id, dependency]);
    await client.query(`INSERT INTO roundhouse.agent_role_refs(job_id,role_id,profile_hash,profile) VALUES ($1,$2,$3,$4)`,
      [id, job.agent_role ?? "general", job.project_context?.agent_profile ? digest(job.project_context.agent_profile) : null, job.project_context?.agent_profile ?? {}]);
    for (const attempt of job.attempts ?? []) {
      const number = attempt.number;
      await client.query(`INSERT INTO roundhouse.job_attempts(job_id,attempt_number,started_at,finished_at,node_id,node_name,failure,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, number, date(attempt.started_at), attempt.finished_at ? date(attempt.finished_at) : null,
        attempt.node_id ?? null, attempt.node_name ?? null, attempt.failure ?? null, attempt]);
      if (attempt.execution) await client.query(`INSERT INTO roundhouse.execution_metadata
        (job_id,attempt_number,command,started_at,finished_at,exit_code,passed,timed_out,overflow,report)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, number, json(attempt.execution.command), attempt.execution.started_at ? date(attempt.execution.started_at) : null,
        attempt.execution.finished_at ? date(attempt.execution.finished_at) : null, attempt.execution.exit_code ?? null, attempt.execution.passed ?? null,
        attempt.execution.timed_out ?? null, attempt.execution.overflow ?? null, attempt.execution.report ?? null]);
      if (attempt.verification) {
        await client.query(`INSERT INTO roundhouse.verification_results(job_id,attempt_number,commit,verified_at,passed,payload)
          VALUES ($1,$2,$3,$4,$5,$6)`, [id, number, attempt.verification.commit ?? null, attempt.verification.at ? date(attempt.verification.at) : null,
          Boolean(attempt.verification.passed), attempt.verification]);
        for (let index = 0; index < (attempt.verification.checks ?? []).length; index += 1) {
          const check = attempt.verification.checks[index];
          await client.query(`INSERT INTO roundhouse.verification_checks(job_id,attempt_number,check_index,check_id,source,passed,payload)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, number, index, check.id, check.source ?? null, Boolean(check.passed), check]);
        }
      }
    }
    if (job.shipping) {
      await client.query(`INSERT INTO roundhouse.shipping_records(job_id,commit,branch,pushed,shipped_at,payload) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, job.shipping.commit ?? null, job.shipping.branch ?? null, job.shipping.pushed ?? null, job.shipping.timestamp ? date(job.shipping.timestamp) : null, job.shipping]);
      if (job.shipping.deployment) {
        const deployment = job.shipping.deployment;
        await client.query(`INSERT INTO roundhouse.deployments(job_id,provider,environment,revision,status,url,payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, deployment.provider ?? null, deployment.environment ?? null, deployment.revision ?? null, deployment.status ?? null, deployment.url ?? null, deployment]);
      }
    }
    for (let index = 0; index < (job.history ?? []).length; index += 1) {
      const event = job.history[index];
      await client.query(`INSERT INTO roundhouse.transition_audit(entity_type,entity_id,revision,from_state,to_state,reason,occurred_at)
        VALUES ('job',$1,$2,$3,$4,$5,$6)`, [id, index + 1, event.from ?? null, event.to, event.reason ?? null, date(event.at)]);
    }
}

async function writeOutboxEvent(client, event) {
  await client.query(`INSERT INTO roundhouse.outbox_events
    (id,entity_id,item_id,source,state,reason,occurred_at,delivered,question_id,question_revision,payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET entity_id=EXCLUDED.entity_id,item_id=EXCLUDED.item_id,source=EXCLUDED.source,
      state=EXCLUDED.state,reason=EXCLUDED.reason,occurred_at=EXCLUDED.occurred_at,delivered=EXCLUDED.delivered,
      question_id=EXCLUDED.question_id,question_revision=EXCLUDED.question_revision,payload=EXCLUDED.payload`, [event.id, event.entity_id, event.item_id, event.source ?? null, event.state,
    event.reason ?? null, date(event.at), Boolean(event.delivered), event.question_id ?? null, event.question_revision ?? null, event]);
}

function validateSnapshotReferences(data, events, subscriptions, deliveries) {
  for (const [id, job] of Object.entries(data.jobs ?? {})) {
    if (!data.items?.[job.parent_id]) throw new Error(`Job ${id} references missing item ${job.parent_id}.`);
  }
  for (const [id, delivery] of Object.entries(deliveries)) {
    if (!subscriptions[delivery.subscription_id]) throw new Error(`MCP delivery ${id} references missing subscription ${delivery.subscription_id}.`);
    if (!events[delivery.outbox_id]) throw new Error(`MCP delivery ${id} references missing outbox event ${delivery.outbox_id}.`);
  }
}

async function writeChanges(client, before, data) {
  const beforeEvents = Object.fromEntries((before.outbox ?? []).map((event) => [event.id, event]));
  const events = Object.fromEntries((data.outbox ?? []).map((event) => [event.id, event]));
  const beforeSubscriptions = before.mcp_events?.subscriptions ?? {};
  const subscriptions = data.mcp_events?.subscriptions ?? {};
  const beforeDeliveries = before.mcp_events?.deliveries ?? {};
  const deliveries = data.mcp_events?.deliveries ?? {};
  const eventState = Object.fromEntries(Object.entries(data.mcp_events ?? {}).filter(([key]) => !["subscriptions", "deliveries"].includes(key)));
  const beforeEventState = Object.fromEntries(Object.entries(before.mcp_events ?? {}).filter(([key]) => !["subscriptions", "deliveries"].includes(key)));
  validateSnapshotReferences(data, events, subscriptions, deliveries);

  for (const id of removedKeys(beforeDeliveries, deliveries)) await client.query("DELETE FROM roundhouse.mcp_deliveries WHERE id=$1", [id]);
  for (const id of removedKeys(before.jobs, data.jobs)) {
    await client.query("DELETE FROM roundhouse.jobs WHERE id=$1", [id]);
    await client.query("DELETE FROM roundhouse.transition_audit WHERE entity_type='job' AND entity_id=$1", [id]);
  }
  for (const id of removedKeys(before.items, data.items)) {
    await client.query("DELETE FROM roundhouse.depot_items WHERE id=$1", [id]);
    await client.query("DELETE FROM roundhouse.depot_item_revisions WHERE item_id=$1", [id]);
    await client.query("DELETE FROM roundhouse.transition_audit WHERE entity_type='item' AND entity_id=$1", [id]);
  }
  for (const id of removedKeys(beforeEvents, events)) await client.query("DELETE FROM roundhouse.outbox_events WHERE id=$1", [id]);
  for (const id of removedKeys(beforeSubscriptions, subscriptions)) await client.query("DELETE FROM roundhouse.mcp_subscriptions WHERE id=$1", [id]);
  for (const id of removedKeys(before.projects, data.projects)) await client.query("DELETE FROM roundhouse.projects WHERE id=$1", [id]);
  for (const id of removedKeys(before.project_candidates, data.project_candidates)) await client.query("DELETE FROM roundhouse.project_candidates WHERE id=$1", [id]);
  for (const key of removedKeys(before.system_metadata, data.system_metadata)) await client.query("DELETE FROM roundhouse.system_metadata WHERE key=$1", [key]);
  for (const key of removedKeys(beforeEventState, eventState)) await client.query("DELETE FROM roundhouse.mcp_event_state WHERE key=$1", [key]);

  for (const [key, value] of changedEntries(before.system_metadata, data.system_metadata)) await client.query(`INSERT INTO roundhouse.system_metadata(key,value)
    VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`, [key, json(value)]);
  for (const [id, project] of changedEntries(before.projects, data.projects)) await writeProject(client, id, project);
  for (const [id, candidate] of changedEntries(before.project_candidates, data.project_candidates)) await writeCandidate(client, id, candidate);
  for (const [id, item] of changedEntries(before.items, data.items)) await writeItem(client, id, item);
  for (const [id, job] of changedEntries(before.jobs, data.jobs)) await writeJob(client, id, job);
  for (const [, event] of changedEntries(beforeEvents, events)) await writeOutboxEvent(client, event);

  for (const [id, subscription] of changedEntries(beforeSubscriptions, subscriptions)) await client.query(`INSERT INTO roundhouse.mcp_subscriptions
    (id,owner,active,next_outbox_index,refresh_before,payload) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO UPDATE SET owner=EXCLUDED.owner,active=EXCLUDED.active,next_outbox_index=EXCLUDED.next_outbox_index,
      refresh_before=EXCLUDED.refresh_before,payload=EXCLUDED.payload`, [id, subscription.owner,
    Boolean(subscription.active), subscription.next_outbox_index ?? 0, subscription.refresh_before ? date(subscription.refresh_before) : null, subscription]);
  for (const [id, delivery] of changedEntries(beforeDeliveries, deliveries)) await client.query(`INSERT INTO roundhouse.mcp_deliveries
    (id,subscription_id,outbox_id,status,attempts,next_attempt_at,lease_until,event_id,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,outbox_id=EXCLUDED.outbox_id,status=EXCLUDED.status,
      attempts=EXCLUDED.attempts,next_attempt_at=EXCLUDED.next_attempt_at,lease_until=EXCLUDED.lease_until,event_id=EXCLUDED.event_id,payload=EXCLUDED.payload`,
  [id, delivery.subscription_id, delivery.outbox_id, delivery.status, delivery.attempts ?? 0,
    delivery.next_attempt_at ? date(delivery.next_attempt_at) : null, delivery.lease_until ? date(delivery.lease_until) : null, delivery.event_id, delivery]);
  for (const [key, value] of changedEntries(beforeEventState, eventState)) await client.query(`INSERT INTO roundhouse.mcp_event_state(key,value)
    VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`, [key, json(value)]);
}

export class PostgresStorageRepository extends StorageRepository {
  constructor({ pool, directory, node, leaseMs = 60_000 }) {
    super({ kind: "postgresql", shared: true });
    this.pool = pool;
    this.directory = path.resolve(directory);
    this.node = node;
    this.leaseMs = leaseMs;
  }

  static async open({ connectionString, directory, node, allowInsecure = false, leaseMs } = {}) {
    if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL storage.");
    const parsed = new URL(connectionString);
    parsed.searchParams.delete("sslmode");
    parsed.searchParams.delete("uselibpqcompat");
    const pool = new Pool({ connectionString: parsed.toString(), ssl: databaseTls(connectionString, allowInsecure), max: 12,
      connectionTimeoutMillis: 5_000, query_timeout: 120_000, application_name: `roundhouse:${node.name}` });
    const store = new PostgresStorageRepository({ pool, directory, node, leaseMs });
    try {
      await store.migrate();
      await store.heartbeatNode("online");
      return store;
    } catch (error) {
      await pool.end().catch(() => {});
      throw new Error(`PostgreSQL storage unavailable: ${error.message}`, { cause: error });
    }
  }

  async migrate() {
    await tx(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [snapshotLock]);
      await client.query("CREATE SCHEMA IF NOT EXISTS roundhouse");
      await client.query(`CREATE TABLE IF NOT EXISTS roundhouse.schema_migrations (
        version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
      const applied = new Set((await rows(client, "SELECT version FROM roundhouse.schema_migrations")).map((row) => row.version));
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        await client.query(fs.readFileSync(migration.file, "utf8"));
        await client.query("INSERT INTO roundhouse.schema_migrations(version,name) VALUES ($1,$2)", [migration.version, migration.name]);
      }
    });
  }

  async read() {
    const client = await this.pool.connect();
    try { return await readSnapshot(client); } finally { client.release(); }
  }

  async change(fn) {
    return tx(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [snapshotLock]);
      const data = await readSnapshot(client);
      const before = structuredClone(data);
      const result = await fn(data);
      await writeChanges(client, before, data);
      return structuredClone(result ?? null);
    });
  }

  async compareAndChange(collection, id, expectedRevision, fn) {
    return this.change((data) => {
      const entity = data[collection]?.[id];
      if (!entity || entity.revision !== expectedRevision) throw new Error("Stale revision; reload authoritative PostgreSQL state.");
      return fn(data, entity);
    });
  }

  async submit(input, key) {
    if (!input || typeof input.text !== "string" || !input.text.trim()) throw new Error("Depot input requires nonempty text.");
    if (typeof key !== "string" || !key.trim()) throw new Error("A stable submission key is required.");
    const id = digest(key).slice(0, 24);
    return this.change((data) => {
      if (data.items[id]) {
        if (digest(data.items[id].input) !== digest(input)) throw new Error("Submission key already exists with different content. Use clarify or a new key.");
        return data.items[id];
      }
      const capturedAt = new Date().toISOString();
      data.items[id] = record(id, { input, raw_idea: rawIdeaEvidence(input, capturedAt), intent: initialIntent(input, capturedAt),
        clarifications: [], questions: [], decision: null, job_ids: [] });
      return data.items[id];
    });
  }

  move(data, entity, state, reason) {
    transition(entity, state, reason);
    const item = entity.parent_id ? data.items[entity.parent_id] : entity;
    data.outbox.push({ id: randomUUID(), entity_id: entity.id, item_id: item.id, source: item.input.source ?? null,
      state, reason, at: new Date().toISOString(), delivered: false });
  }

  async heartbeatNode(status = "online") {
    await this.pool.query(`INSERT INTO roundhouse.nodes(id,name,capabilities,status,started_at,last_heartbeat_at,metadata)
      VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp(),$5)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, capabilities=EXCLUDED.capabilities, status=EXCLUDED.status,
        last_heartbeat_at=clock_timestamp(), metadata=EXCLUDED.metadata`, [this.node.id, this.node.name, this.node.capabilities, status,
      { pid: process.pid, version: process.env.npm_package_version ?? null }]);
  }

  async acquireLease(kind, key, payload = {}, leaseMs = this.leaseMs) {
    const token = randomUUID();
    const result = await this.pool.query(`INSERT INTO roundhouse.resource_leases
      (resource_kind,resource_key,owner_node_id,token,acquired_at,heartbeat_at,expires_at,payload)
      VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp(),clock_timestamp()+($5 * interval '1 millisecond'),$6)
      ON CONFLICT (resource_kind,resource_key) DO UPDATE SET owner_node_id=EXCLUDED.owner_node_id, token=EXCLUDED.token,
        acquired_at=EXCLUDED.acquired_at, heartbeat_at=EXCLUDED.heartbeat_at, expires_at=EXCLUDED.expires_at, payload=EXCLUDED.payload
      WHERE roundhouse.resource_leases.expires_at <= clock_timestamp()
      RETURNING resource_kind,resource_key,owner_node_id,token,acquired_at,heartbeat_at,expires_at,payload`,
    [kind, key, this.node.id, token, leaseMs, payload]);
    if (!result.rowCount) return null;
    return { ...result.rows[0], token };
  }

  async heartbeatLease(lease, leaseMs = this.leaseMs) {
    const result = await this.pool.query(`UPDATE roundhouse.resource_leases SET heartbeat_at=clock_timestamp(),
      expires_at=clock_timestamp()+($5 * interval '1 millisecond')
      WHERE resource_kind=$1 AND resource_key=$2 AND owner_node_id=$3 AND token=$4 AND expires_at>clock_timestamp()
      RETURNING expires_at`, [lease.resource_kind, lease.resource_key, this.node.id, lease.token, leaseMs]);
    if (!result.rowCount) throw new Error(`Lease lost: ${lease.resource_kind}/${lease.resource_key}`);
    return result.rows[0];
  }

  async assertLease(lease) {
    const result = await this.pool.query(`SELECT 1 FROM roundhouse.resource_leases
      WHERE resource_kind=$1 AND resource_key=$2 AND owner_node_id=$3 AND token=$4 AND expires_at>clock_timestamp()`,
    [lease.resource_kind, lease.resource_key, this.node.id, lease.token]);
    if (!result.rowCount) throw new Error(`Lease lost: ${lease.resource_kind}/${lease.resource_key}`);
  }

  async releaseLease(lease) {
    await tx(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [snapshotLock]);
      const result = await client.query(`DELETE FROM roundhouse.resource_leases WHERE resource_kind=$1 AND resource_key=$2 AND owner_node_id=$3 AND token=$4
        RETURNING resource_kind,resource_key`, [lease.resource_kind, lease.resource_key, this.node.id, lease.token]);
      if (result.rowCount && lease.resource_kind === "job") {
        await client.query("UPDATE roundhouse.jobs SET owning_node_id=NULL WHERE id=$1 AND owning_node_id=$2", [lease.resource_key, this.node.id]);
      }
    });
  }

  async claimJob(jobIds, options = this.leaseMs) {
    const leaseMs = typeof options === "number" ? options : (options.leaseMs ?? this.leaseMs);
    const execution = typeof options === "number" ? null : options.execution;
    const reservations = typeof options === "number" ? {} : (options.reservations ?? {});
    const returnEvidence = typeof options !== "number" && options.returnEvidence === true;
    const token = randomUUID();
    return tx(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [snapshotLock]);
      const candidates = await rows(client, `SELECT j.id,j.project_id,j.payload FROM roundhouse.jobs j
          LEFT JOIN roundhouse.resource_leases l ON l.resource_kind='job' AND l.resource_key=j.id AND l.expires_at>clock_timestamp()
          WHERE j.state='Ready' AND j.id=ANY($1::text[]) AND l.resource_key IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM roundhouse.job_dependencies d
              LEFT JOIN roundhouse.jobs dependency ON dependency.id=d.depends_on_job_id
              WHERE d.job_id=j.id AND dependency.state IS DISTINCT FROM 'Shipped'
            )
          ORDER BY array_position($1::text[],j.id) FOR UPDATE OF j SKIP LOCKED`, [jobIds]);
      const activeRows = await rows(client, `SELECT l.payload,j.project_id,j.payload AS job_payload
        FROM roundhouse.resource_leases l
        LEFT JOIN roundhouse.jobs j ON j.id=l.resource_key
        WHERE l.resource_kind='job' AND l.expires_at>clock_timestamp()`);
      const active = activeRows.map((row) => row.payload?.reservation ?? {
        project_id: row.project_id,
        project_limit: 1,
        capacity_units: 1,
        required_capabilities: row.job_payload?.project_context?.required_capabilities ?? [],
        resources: row.job_payload?.project_context?.resource_requirements ?? {},
        locks: row.job_payload?.project_context?.repository ? [`repository:${row.job_payload.project_context.repository}`] : [],
      });
      let selected;
      let reservation;
      const claimEvidence = [];
      for (const candidate of candidates) {
        const proposed = reservations[candidate.id] ?? {
          project_id: candidate.project_id,
          project_limit: 1,
          capacity_units: 1,
          required_capabilities: [],
          resources: {},
          locks: [],
        };
        const policy = execution ?? { capacity: Number.MAX_SAFE_INTEGER, capabilities: proposed.required_capabilities, resource_limits: {} };
        const assessment = reservationAssessment(active, proposed, policy);
        claimEvidence.push({ job_id: candidate.id, ...assessment });
        if (!execution || assessment.fits) {
          selected = candidate;
          reservation = proposed;
          break;
        }
      }
      if (!selected) return returnEvidence ? { job: null, claim_evidence: claimEvidence } : null;
      const payload = { operation: "execution", reservation };
      const result = await client.query(`INSERT INTO roundhouse.resource_leases
        (resource_kind,resource_key,owner_node_id,token,acquired_at,heartbeat_at,expires_at,payload)
        VALUES ('job',$1,$2,$3,clock_timestamp(),clock_timestamp(),clock_timestamp()+($4 * interval '1 millisecond'),$5)
        ON CONFLICT (resource_kind,resource_key) DO UPDATE SET owner_node_id=EXCLUDED.owner_node_id,token=EXCLUDED.token,
          acquired_at=EXCLUDED.acquired_at,heartbeat_at=EXCLUDED.heartbeat_at,expires_at=EXCLUDED.expires_at,payload=EXCLUDED.payload
        WHERE roundhouse.resource_leases.expires_at<=clock_timestamp()
        RETURNING resource_key`, [selected.id, this.node.id, token, leaseMs, payload]);
      if (!result.rowCount) return returnEvidence ? { job: null, claim_evidence: claimEvidence } : null;
      await client.query("UPDATE roundhouse.jobs SET owning_node_id=$2 WHERE id=$1", [selected.id, this.node.id]);
      const job = selected.payload;
      return { job, lease: { resource_kind: "job", resource_key: job.id, owner_node_id: this.node.id, token, reservation },
        ...(returnEvidence ? { claim_evidence: claimEvidence } : {}) };
    });
  }

  async claimRemoteCommand() {
    return tx(this.pool, async (client) => {
      const result = await client.query(`WITH next AS (
          SELECT id FROM roundhouse.remote_commands
          WHERE status='queued' ORDER BY created_at,id
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE roundhouse.remote_commands command
        SET status='processing', claimed_at=clock_timestamp(), claimed_by=$1
        FROM next WHERE command.id=next.id
        RETURNING command.id,command.kind,command.payload,command.created_at`, [this.node.id]);
      return result.rows[0] ?? null;
    });
  }

  async finishRemoteCommand(id, { result = null, error = null } = {}) {
    const status = error ? "failed" : "completed";
    const response = await this.pool.query(`UPDATE roundhouse.remote_commands
      SET status=$2,result=$3,error=$4,finished_at=clock_timestamp()
      WHERE id=$1 AND status='processing' AND claimed_by=$5
      RETURNING id,status,result,error,finished_at`, [id, status, result, error, this.node.id]);
    if (!response.rowCount) throw new Error(`Remote command ownership lost: ${id}`);
    return response.rows[0];
  }

  async recoverExpiredClaims() {
    return tx(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [snapshotLock]);
      const data = await readSnapshot(client);
      const before = structuredClone(data);
      const expired = await rows(client, `SELECT j.id,l.payload AS lease_payload FROM roundhouse.jobs j
        LEFT JOIN roundhouse.resource_leases l ON l.resource_kind='job' AND l.resource_key=j.id
        WHERE (j.state IN ('Executing','Verification','Rework') AND (l.resource_key IS NULL OR l.expires_at<=clock_timestamp()))
          OR (j.state='Ready' AND l.expires_at<=clock_timestamp() AND l.payload->>'operation'='execution')`);
      const expiredItems = await rows(client, `SELECT i.id FROM roundhouse.depot_items i
        LEFT JOIN roundhouse.resource_leases l ON l.resource_kind='item' AND l.resource_key=i.id
        WHERE i.state='Decision' AND COALESCE((i.payload->>'awaiting_decision')::boolean,false)=false
          AND (l.resource_key IS NULL OR l.expires_at<=clock_timestamp())`);
      for (const { id } of expired) {
        const job = data.jobs[id];
        if (!job || job.state === "Blocked") continue;
        const remote = job.attempts?.at(-1)?.execution?.remote_execution;
        this.move(data, job, "Blocked", job.delivery_intent
          ? "Expired owner lease after delivery intent; reconcile the remote before replacement work."
          : remote
            ? `Expired owner lease interrupted Herdr execution on ${remote.machine_selector}/${remote.agent_target}; explicit reconciliation is required and the prompt will not be replayed automatically.`
            : "Expired owner lease interrupted execution; inspect the workspace before replacement work.");
        const attempt = job.attempts?.at(-1);
        if (attempt) {
          const recordedAt = new Date().toISOString();
          attempt.status = "blocked";
          attempt.failure ??= job.history.at(-1).reason;
          attempt.finished_at ??= recordedAt;
          job.reconciliation = { required: true, status: "required", reason: job.history.at(-1).reason,
            intent: job.delivery_intent ? structuredClone(job.delivery_intent) : null,
            run_id: attempt.run?.id ?? null, recorded_at: recordedAt };
          if (attempt.run) {
            attempt.run.status = "blocked";
            attempt.run.reconciliation = job.reconciliation;
          }
        }
        data.projects[job.project_id] = { ...data.projects[job.project_id], active: false, blocked: true };
      }
      for (const { id } of expiredItems) {
        const item = data.items[id];
        if (item?.state === "Decision") {
          this.move(data, item, "Blocked", "Expired owner lease interrupted decision work; explicit retry is required.");
          item.triage ??= { attempts: [], failure_count: 0 };
          item.triage.status = "interrupted";
          item.triage.interrupted = true;
        }
      }
      const recovered = expired.length + expiredItems.length;
      if (recovered) await writeChanges(client, before, data);
      return recovered;
    });
  }

  async status() {
    try {
      const result = await this.pool.query("SELECT clock_timestamp() AS checked_at");
      return { kind: this.kind, shared: true, authoritative: true, connected: true, read_only: false,
        checked_at: result.rows[0].checked_at.toISOString(), node: { id: this.node.id, name: this.node.name, capabilities: this.node.capabilities } };
    } catch (error) {
      return { kind: this.kind, shared: true, authoritative: true, connected: false, read_only: true,
        error: "PostgreSQL unavailable", ...(error.code ? { error_code: error.code } : {}),
        node: { id: this.node.id, name: this.node.name, capabilities: this.node.capabilities } };
    }
  }

  async close() {
    await this.heartbeatNode("offline").catch(() => {});
    await this.pool.end();
  }
}
