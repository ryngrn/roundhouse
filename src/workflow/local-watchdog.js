import { alive as systemProcessAlive } from "../storage/file-lock.js";

export const DEFAULT_WATCHDOG_CHECK_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_WATCHDOG_STALE_THRESHOLD_MS = 10 * 60_000;
export const WATCHDOG_ACTIVE_STATES = new Set(["Decision", "Executing", "Verification", "Rework"]);
const ACTIVITY_KINDS = new Set(["executor_process", "verification_process", "lease_heartbeat", "durable_progress"]);

const iso = (value) => {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

export function recordWatchdogActivity(entity, { kind, phase = null, at = Date.now(), ...evidence }) {
  if (!entity || typeof entity !== "object") throw new Error("Watchdog activity requires a durable entity.");
  if (!ACTIVITY_KINDS.has(kind)) throw new Error(`Unsupported watchdog activity kind: ${kind}`);
  const recordedAt = iso(at);
  if (!recordedAt) throw new Error("Watchdog activity requires a valid timestamp.");
  entity.watchdog_evidence ??= { last_credible_activity_at: null, signals: {} };
  const signal = { kind, phase, at: recordedAt, ...evidence };
  entity.watchdog_evidence.signals[kind] = signal;
  const previous = Date.parse(entity.watchdog_evidence.last_credible_activity_at);
  if (!Number.isFinite(previous) || Date.parse(recordedAt) >= previous) entity.watchdog_evidence.last_credible_activity_at = recordedAt;
  return signal;
}

function recent(timestamp, now, thresholdMs) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed <= now && now - parsed <= thresholdMs;
}

function processEvidence(entity, processAlive, now) {
  const evidence = [];
  const errors = [];
  for (const entry of entity.processes ?? []) {
    const pid = Number(entry.pid);
    if (!Number.isInteger(pid) || pid < 1) continue;
    try {
      if (processAlive(pid)) evidence.push({ kind: entry.phase === "verification" ? "verification_process" : "executor_process",
        at: iso(now), started_at: entry.started_at ?? entry.at ?? null, pid, phase: entry.phase ?? "execution" });
    } catch (error) { errors.push(`Could not inspect registered process ${pid}: ${error.message}`); }
  }
  return { evidence, errors };
}

export function classifyWatchdogEntity(entity, {
  now = Date.now(), staleThresholdMs = DEFAULT_WATCHDOG_STALE_THRESHOLD_MS,
  processAlive = systemProcessAlive, leaseHeartbeatAt = null,
} = {}) {
  if (!Number.isFinite(now)) throw new Error("Watchdog classification requires a valid current time.");
  if (!Number.isInteger(staleThresholdMs) || staleThresholdMs < 1) throw new Error("Watchdog stale threshold must be a positive integer.");
  const active = WATCHDOG_ACTIVE_STATES.has(entity?.state);
  if (!active) return { status: "idle", active: false, stale: false, last_credible_activity_at: null, evidence: [] };

  const processInspection = processEvidence(entity, processAlive, now);
  const liveProcesses = processInspection.evidence;
  if (liveProcesses.length) {
    const last = liveProcesses.map((entry) => entry.at).filter(Boolean).sort().at(-1) ?? null;
    return { status: "healthy", active: true, stale: false, last_credible_activity_at: last,
      reason: "A registered execution or verification child process is alive.", evidence: liveProcesses };
  }

  const signals = entity.watchdog_evidence?.signals ?? {};
  const heartbeatAt = leaseHeartbeatAt ?? signals.lease_heartbeat?.at ?? null;
  const progressAt = signals.durable_progress?.at ?? null;
  const evidence = [];
  if (recent(heartbeatAt, now, staleThresholdMs)) evidence.push({ kind: "lease_heartbeat", at: iso(heartbeatAt) });
  if (recent(progressAt, now, staleThresholdMs)) evidence.push({ kind: "durable_progress", at: iso(progressAt), phase: signals.durable_progress?.phase ?? null });
  if (evidence.length) {
    const last = evidence.map((entry) => entry.at).sort().at(-1);
    return { status: "healthy", active: true, stale: false, last_credible_activity_at: last,
      reason: "Authoritative lease heartbeat or durable progress is recent.", evidence };
  }

  if (processInspection.errors.length) {
    return { status: "unknown", active: true, stale: false, last_credible_activity_at: null,
      reason: "Registered process liveness could not be inspected; stale classification was withheld.", evidence: [],
      error: processInspection.errors.join(" ") };
  }

  const lastKnown = [progressAt, heartbeatAt, entity.watchdog_evidence?.last_credible_activity_at]
    .map((value) => Date.parse(value)).filter((value) => Number.isFinite(value) && value <= now).sort((a, b) => b - a)[0] ?? null;
  const baseline = [lastKnown, entity.updated_at, entity.attempts?.at(-1)?.started_at, entity.created_at]
    .map((value) => typeof value === "number" ? value : Date.parse(value))
    .filter((value) => Number.isFinite(value) && value <= now).sort((a, b) => b - a)[0] ?? null;
  const stale = baseline !== null && now - baseline >= staleThresholdMs;
  return { status: stale ? "stale" : "monitoring", active: true, stale, last_credible_activity_at: iso(lastKnown),
    reason: stale
      ? "Active state has no registered live child and no recent authoritative heartbeat or durable progress."
      : "Active state has no current credible activity yet, but has not exceeded the stale threshold.",
    evidence: [] };
}

export function watchdogStatus(data, config = {}, options = {}) {
  const checkIntervalMs = config.check_interval_ms ?? DEFAULT_WATCHDOG_CHECK_INTERVAL_MS;
  const staleThresholdMs = config.stale_threshold_ms ?? DEFAULT_WATCHDOG_STALE_THRESHOLD_MS;
  if (config.enabled === false) return { enabled: false, mode: "observe_only", check_interval_ms: checkIntervalMs,
    stale_threshold_ms: staleThresholdMs, last_check_at: iso(options.now ?? Date.now()), active: [], active_item: null,
    last_credible_activity_at: null, stale_count: 0, last_action: "Watchdog observation is disabled.", error: null };
  const entities = [
    ...Object.values(data?.items ?? {}).map((entity) => ({ type: "triage", entity })),
    ...Object.values(data?.jobs ?? {}).map((entity) => ({ type: "job", entity })),
  ].filter(({ entity }) => WATCHDOG_ACTIVE_STATES.has(entity.state));
  const results = entities.map(({ type, entity }) => ({ type, id: entity.id, project_id: entity.project_id ?? null,
    state: entity.state, ...classifyWatchdogEntity(entity, { ...options, staleThresholdMs }) }))
    .sort((a, b) => Number(b.stale) - Number(a.stale) || a.type.localeCompare(b.type) || String(a.id).localeCompare(String(b.id)));
  const stale = results.filter((entry) => entry.stale);
  const errors = results.map((entry) => entry.error).filter(Boolean);
  const latest = results.map((entry) => entry.last_credible_activity_at).filter(Boolean).sort().at(-1) ?? null;
  return { enabled: config.enabled !== false, mode: "observe_only", check_interval_ms: checkIntervalMs,
    stale_threshold_ms: staleThresholdMs, last_check_at: iso(options.now ?? Date.now()), active: results,
    active_item: results[0] ? { type: results[0].type, id: results[0].id, project_id: results[0].project_id, state: results[0].state } : null,
    last_credible_activity_at: latest, stale_count: stale.length,
    last_action: stale.length ? "Stale attempt declared; recovery remains approval-gated and is not performed by this contract." : "No action required.",
    error: errors.length ? errors.join(" ") : null };
}
