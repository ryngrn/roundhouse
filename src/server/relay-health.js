const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RELAY_STATES = Object.freeze({
  CONNECTED: "Connected",
  WAKE_VERIFIED: "Wake Verified",
  HEARTBEAT_ONLY: "Heartbeat Only",
  DISCONNECTED: "Disconnected",
});

const verificationFailures = new Set(["http_status", "connection_error", "invalid_response", "timeout", "configuration_mismatch"]);
const iso = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
};
const nonnegativeInteger = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const boundedBackoff = (value) => Math.min(nonnegativeInteger(value), 24 * HOUR_MS);

export function sanitizeRelayHealthEvidence(value = {}, { queryBudget = 500, now = Date.now() } = {}) {
  const verification = value.wake_verification ?? {};
  const reconnect = value.reconnect ?? {};
  const usage = value.query_usage ?? {};
  const budget = Math.max(1, Math.min(nonnegativeInteger(usage.budget, queryBudget), 100_000));
  const used = Math.min(nonnegativeInteger(usage.used), budget);
  const status = ["unknown", "verified", "failed"].includes(verification.status) ? verification.status : "unknown";
  const connectionStatus = ["idle", "connected", "backoff"].includes(reconnect.status) ? reconnect.status : "idle";
  const failure = verificationFailures.has(verification.failure) ? verification.failure : verification.failure ? "unclassified" : null;
  return {
    version: 1,
    observing_since_at: iso(value.observing_since_at) ?? new Date(now).toISOString(),
    last_wake_received_at: iso(value.last_wake_received_at),
    last_successful_sync_at: iso(value.last_successful_sync_at),
    wake_verification: {
      status,
      checked_at: iso(verification.checked_at),
      failure,
      configuration: ["unknown", "matched", "mismatched"].includes(verification.configuration)
        ? verification.configuration : "unknown",
      reconciled: verification.reconciled === true,
    },
    reconnect: {
      status: connectionStatus,
      consecutive_failures: Math.min(nonnegativeInteger(reconnect.consecutive_failures), 1_000_000),
      backoff_ms: boundedBackoff(reconnect.backoff_ms),
      next_retry_at: iso(reconnect.next_retry_at),
    },
    query_usage: {
      window_started_at: iso(usage.window_started_at) ?? new Date(now).toISOString(),
      used,
      budget,
      exhausted: used >= budget,
    },
  };
}

export function deriveRelayHealth(evidence, { now = Date.now(), wakeFreshMs = HOUR_MS,
  verificationFreshMs = 6 * HOUR_MS, syncFreshMs = 15 * 60 * 1000, driftAlertMs = HOUR_MS } = {}) {
  const clean = sanitizeRelayHealthEvidence(evidence, { now });
  const age = (timestamp) => timestamp ? Math.max(0, now - Date.parse(timestamp)) : Infinity;
  const syncAge = age(clean.last_successful_sync_at);
  const wakeAge = age(clean.last_wake_received_at);
  const verificationAge = age(clean.wake_verification.checked_at);
  const syncFresh = syncAge <= syncFreshMs;
  const wakeFresh = wakeAge <= wakeFreshMs;
  const verificationFresh = clean.wake_verification.status === "verified" && verificationAge <= verificationFreshMs;
  let state = RELAY_STATES.DISCONNECTED;
  if (syncFresh && wakeFresh) state = RELAY_STATES.CONNECTED;
  else if (syncFresh && verificationFresh) state = RELAY_STATES.WAKE_VERIFIED;
  else if (syncFresh) state = RELAY_STATES.HEARTBEAT_ONLY;
  const observingAge = age(clean.observing_since_at);
  const lastChannelProof = [clean.last_wake_received_at,
    clean.wake_verification.status === "verified" ? clean.wake_verification.checked_at : null]
    .filter(Boolean).sort().at(-1) ?? null;
  const driftSince = state === RELAY_STATES.WAKE_VERIFIED ? (clean.last_wake_received_at ? wakeAge : observingAge)
    : state === RELAY_STATES.HEARTBEAT_ONLY ? (lastChannelProof ? age(lastChannelProof) : observingAge)
      : state === RELAY_STATES.DISCONNECTED ? (clean.last_successful_sync_at ? syncAge : observingAge) : 0;
  const persistentDrift = state !== RELAY_STATES.CONNECTED && driftSince >= driftAlertMs;
  return {
    state,
    observed_at: new Date(now).toISOString(),
    evidence: clean,
    freshness: { sync: syncFresh, wake: wakeFresh, wake_verification: verificationFresh },
    alert: persistentDrift ? { code: "persistent_relay_drift", since_ms: Math.floor(driftSince) } : null,
  };
}

export class RelayHealthMonitor {
  constructor({ store, enabled = true, now = () => Date.now(), queryBudget = 500,
    queryWindowMs = DAY_MS, derivation = {} } = {}) {
    this.store = store;
    this.enabled = Boolean(enabled && store?.getRelayHealthEvidence && store?.saveRelayHealthEvidence);
    this.now = now;
    this.queryBudget = queryBudget;
    this.queryWindowMs = queryWindowMs;
    this.derivation = derivation;
    this.evidence = sanitizeRelayHealthEvidence({}, { queryBudget, now: now() });
    this.started = false;
    this.writeTail = Promise.resolve();
  }

  async start() {
    if (!this.enabled || this.started) return;
    const stored = await this.store.getRelayHealthEvidence();
    this.evidence = sanitizeRelayHealthEvidence(stored ?? {}, { queryBudget: this.queryBudget, now: this.now() });
    this.rollQueryWindow();
    this.started = true;
  }

  rollQueryWindow() {
    if (this.now() - Date.parse(this.evidence.query_usage.window_started_at) < this.queryWindowMs) return;
    this.evidence.query_usage = {
      window_started_at: new Date(this.now()).toISOString(), used: 0,
      budget: this.evidence.query_usage.budget, exhausted: false,
    };
  }

  persist() {
    if (!this.enabled) return Promise.resolve();
    const snapshot = structuredClone(this.evidence);
    this.writeTail = this.writeTail.catch(() => {}).then(() => this.store.saveRelayHealthEvidence(snapshot));
    return this.writeTail;
  }

  async mutate(fn) {
    if (!this.enabled) return;
    await this.start();
    this.rollQueryWindow();
    fn(this.evidence);
    this.evidence = sanitizeRelayHealthEvidence(this.evidence, { queryBudget: this.queryBudget, now: this.now() });
    await this.persist();
  }

  recordWakeReceived() {
    return this.mutate((evidence) => {
      evidence.last_wake_received_at = new Date(this.now()).toISOString();
      evidence.wake_verification = { status: "verified", checked_at: evidence.last_wake_received_at, failure: null };
      evidence.reconnect = { status: "connected", consecutive_failures: 0, backoff_ms: 0, next_retry_at: null };
    });
  }

  recordWakeVerification({ verified, failure = null, configurationMatched, reconciled = false } = {}) {
    return this.mutate((evidence) => {
      evidence.wake_verification = { status: verified ? "verified" : "failed",
        checked_at: new Date(this.now()).toISOString(), failure: verified ? null : failure,
        configuration: configurationMatched === true ? "matched"
          : configurationMatched === false ? "mismatched" : evidence.wake_verification.configuration,
        reconciled: reconciled === true };
    });
  }

  recordSuccessfulSync({ queries = 1 } = {}) {
    return this.mutate((evidence) => {
      evidence.last_successful_sync_at = new Date(this.now()).toISOString();
      evidence.query_usage.used += nonnegativeInteger(queries);
    });
  }

  recordBackoff({ consecutiveFailures = 1, backoffMs = 0 } = {}) {
    return this.mutate((evidence) => {
      const delay = boundedBackoff(backoffMs);
      evidence.reconnect = { status: "backoff", consecutive_failures: consecutiveFailures,
        backoff_ms: delay, next_retry_at: new Date(this.now() + delay).toISOString() };
    });
  }

  reserveQueries(count = 1) {
    this.rollQueryWindow();
    const requested = nonnegativeInteger(count);
    return requested > 0 && this.evidence.query_usage.used + requested <= this.evidence.query_usage.budget;
  }

  status() {
    return { enabled: this.enabled, ...deriveRelayHealth(this.evidence, { now: this.now(), ...this.derivation }) };
  }
}
