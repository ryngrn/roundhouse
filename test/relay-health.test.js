import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { deriveRelayHealth, RelayHealthMonitor, RELAY_STATES } from "../src/server/relay-health.js";
import { HttpWakeSource } from "../src/server/wake-source.js";
import { WakeChannelVerifier, probeWakeChannel, verifiedWakeConfiguration } from "../src/server/wake-channel-verifier.js";
import { WorkerLoop } from "../src/server/worker.js";
import { Store } from "../src/workflow/store.js";

const minute = 60 * 1000;
const base = Date.parse("2026-07-01T12:00:00.000Z");
const at = (offset) => new Date(base + offset).toISOString();
const evidence = ({ wake, sync, verified, checked = 0 } = {}) => ({
  last_wake_received_at: wake == null ? null : at(wake),
  last_successful_sync_at: sync == null ? null : at(sync),
  wake_verification: { status: verified === true ? "verified" : verified === false ? "failed" : "unknown",
    checked_at: verified == null ? null : at(checked), failure: verified === false ? "timeout" : null },
});

test("relay health deterministically derives all four visible states and stale transitions", () => {
  const options = { now: base, wakeFreshMs: 10 * minute, verificationFreshMs: 30 * minute, syncFreshMs: 5 * minute };
  assert.equal(deriveRelayHealth(evidence({ wake: -minute, sync: -minute }), options).state, RELAY_STATES.CONNECTED);
  assert.equal(deriveRelayHealth(evidence({ wake: -20 * minute, sync: -minute, verified: true, checked: -minute }), options).state,
    RELAY_STATES.WAKE_VERIFIED);
  assert.equal(deriveRelayHealth(evidence({ sync: -minute, verified: false, checked: -minute }), options).state,
    RELAY_STATES.HEARTBEAT_ONLY);
  assert.equal(deriveRelayHealth(evidence({ wake: -minute, sync: -10 * minute, verified: true }), options).state,
    RELAY_STATES.DISCONNECTED);
  assert.equal(deriveRelayHealth(evidence({ wake: -11 * minute, sync: -minute }), options).state, RELAY_STATES.HEARTBEAT_ONLY);
  assert.equal(deriveRelayHealth(evidence({ wake: -minute, sync: -6 * minute }), options).state, RELAY_STATES.DISCONNECTED);
});

test("relay observations persist across restart with retry and bounded query evidence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-relay-health-"));
  let now = base;
  const first = new RelayHealthMonitor({ store: new Store(directory), now: () => now, queryBudget: 2,
    derivation: { wakeFreshMs: 10 * minute, syncFreshMs: 5 * minute } });
  await first.start();
  await first.recordWakeVerification({ verified: true });
  await first.recordSuccessfulSync({ queries: 2 });
  await first.recordBackoff({ consecutiveFailures: 3, backoffMs: 30_000 });
  assert.equal(first.status().state, RELAY_STATES.WAKE_VERIFIED);
  assert.deepEqual(first.status().evidence.reconnect, { status: "backoff", consecutive_failures: 3,
    backoff_ms: 30_000, next_retry_at: "2026-07-01T12:00:30.000Z" });
  assert.deepEqual(first.status().evidence.query_usage, { window_started_at: "2026-07-01T12:00:00.000Z",
    used: 2, budget: 2, exhausted: true });
  assert.equal(first.reserveQueries(1), false);

  now += minute;
  const restarted = new RelayHealthMonitor({ store: new Store(directory), now: () => now, queryBudget: 2,
    derivation: { wakeFreshMs: 10 * minute, syncFreshMs: 5 * minute } });
  await restarted.start();
  assert.equal(restarted.status().state, RELAY_STATES.WAKE_VERIFIED);
  assert.equal(restarted.status().evidence.reconnect.consecutive_failures, 3);
  assert.equal(restarted.status().evidence.query_usage.exhausted, true);
});

test("relay health stores only allowlisted non-secret evidence and emits persistent drift alerts", async () => {
  let saved;
  const store = {
    getRelayHealthEvidence: async () => null,
    saveRelayHealthEvidence: async (value) => { saved = value; },
  };
  const monitor = new RelayHealthMonitor({ store, now: () => base, derivation: { driftAlertMs: 0 } });
  await monitor.recordWakeVerification({ verified: false,
    failure: "https://user:secret@wake.example/private-topic?token=credential" });
  await monitor.recordBackoff({ consecutiveFailures: 4, backoffMs: Number.MAX_SAFE_INTEGER,
    topic: "private-topic", credential: "secret" });
  const serialized = JSON.stringify(saved);
  assert.doesNotMatch(serialized, /secret|private-topic|wake\.example|credential/);
  assert.equal(saved.wake_verification.failure, "unclassified");
  assert.equal(saved.reconnect.backoff_ms, 24 * 60 * 60 * 1000);

  await monitor.recordSuccessfulSync();
  const status = monitor.status();
  assert.equal(status.state, RELAY_STATES.HEARTBEAT_ONLY);
  assert.equal(status.alert.code, "persistent_relay_drift");
});

test("wake source emits only structured verification and retry observations", async () => {
  const observations = [];
  const timers = [];
  const requests = [];
  const health = {
    recordWakeVerification: async (value) => observations.push(["verification", value]),
    recordBackoff: async (value) => observations.push(["backoff", value]),
    recordWakeReceived: async () => observations.push(["wake"]),
  };
  const source = new HttpWakeSource({
    url: "https://wake.example/private-topic/json?token=secret",
    health,
    minimumBackoffMs: 100,
    maximumBackoffMs: 200,
    random: () => 0,
    setTimeoutFn: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimeoutFn: () => {},
    get: () => { const request = new EventEmitter(); request.destroy = () => {}; requests.push(request); return request; },
  });
  source.start();
  requests[0].emit("error", new Error("credential leaked in transport error"));
  await Promise.resolve();
  assert.deepEqual(observations, [
    ["verification", { verified: false, failure: "connection_error" }],
    ["backoff", { consecutiveFailures: 1, backoffMs: 50 }],
  ]);
  assert.doesNotMatch(JSON.stringify(observations), /secret|private-topic|credential/);
  source.stop();
});

test("independent channel probes time out with structured secret-free evidence", async () => {
  let timeout;
  let destroyed = false;
  const request = new EventEmitter();
  request.destroy = () => { destroyed = true; };
  const checking = probeWakeChannel(new URL("https://wake.example/private-topic?token=secret"), {
    get: () => request,
    timeoutMs: 250,
    setTimeoutFn: (callback, delay) => {
      timeout = { callback, delay, unref() {} };
      return timeout;
    },
    clearTimeoutFn: () => {},
  });
  assert.equal(timeout.delay, 250);
  timeout.callback();
  const result = await checking;
  assert.deepEqual(result, { verified: false, failure: "timeout" });
  assert.equal(destroyed, true);
  assert.doesNotMatch(JSON.stringify(result), /private-topic|secret/);
});

const verifierClock = () => {
  let now = base;
  const timers = [];
  return {
    timers,
    now: () => now,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, active: true, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.active = false; },
    async fire(timer) {
      assert.equal(timer.active, true);
      timer.active = false;
      now += timer.delay;
      await timer.callback();
    },
  };
};

test("independent channel verification safely reconciles only to verified startup configuration", async () => {
  const clock = verifierClock();
  const expected = "https://wake.example/operator-topic/json?token=private";
  const observations = [];
  let active = "https://wake.example/drifted-topic/json";
  const source = {
    matches: (url) => new URL(active).href === url.href,
    reconcile: (url) => { active = url.href; },
  };
  const verifier = new WakeChannelVerifier({
    source,
    configuration: verifiedWakeConfiguration(expected),
    probe: async () => ({ verified: true }),
    health: { recordWakeVerification: async (value) => observations.push(value) },
    intervalMs: 60_000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    now: clock.now,
  });

  const result = await verifier.start();
  await Promise.resolve();
  assert.deepEqual(result, { checked: true, verified: true, mismatch: true, reconciled: true });
  assert.equal(active, expected);
  assert.deepEqual(observations, [{ verified: true, configurationMatched: false, reconciled: true }]);
  assert.equal(clock.timers[0].delay, 60_000);
  assert.equal(verifier.status().next_check_at, at(60_000));
  assert.doesNotMatch(JSON.stringify(verifier.status()), /operator-topic|private/);

  await clock.fire(clock.timers[0]);
  await Promise.resolve();
  assert.equal(observations[1].configurationMatched, true);
  await verifier.stop();
});

test("channel verification uses bounded equal-jitter retries and recovers after restart", async () => {
  const clock = verifierClock();
  const configuration = verifiedWakeConfiguration("https://wake.example/operator-topic/json");
  let reconciliations = 0;
  const source = { matches: () => false, reconcile: () => { reconciliations += 1; } };
  let attempts = 0;
  const failingProbe = async () => { attempts += 1; return { verified: false, failure: "timeout" }; };
  const options = { source, configuration, probe: failingProbe, intervalMs: 10_000,
    minimumBackoffMs: 100, maximumBackoffMs: 150, maxRetries: 2, random: () => 0,
    setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn, now: clock.now };
  const first = new WakeChannelVerifier(options);

  assert.equal((await first.start()).retrying, true);
  assert.equal(first.status().retrying, true);
  assert.equal(clock.timers[0].delay, 50);
  await clock.fire(clock.timers[0]);
  assert.equal(clock.timers[1].delay, 75, "retry backoff is capped before jitter");
  await clock.fire(clock.timers[1]);
  assert.equal(attempts, 3);
  assert.equal(reconciliations, 0, "a failed probe cannot authorize reconciliation");
  assert.equal(clock.timers[2].delay, 10_000, "exhausted retries return to the low-frequency cadence");
  assert.equal(first.status().consecutive_failures, 3);
  assert.equal(first.status().retrying, false);
  await first.stop();

  const restarted = new WakeChannelVerifier({ ...options, probe: async () => ({ verified: true }) });
  const recovered = await restarted.start();
  assert.equal(recovered.verified, true);
  assert.equal(reconciliations, 1, "restart recovery reconciles only after a successful probe");
  assert.equal(restarted.status().consecutive_failures, 0);
  assert.equal(restarted.status().retrying, false);
  assert.equal(clock.timers[3].delay, 10_000);
  await restarted.stop();
});

test("unverified wake configuration is a strict no-op", async () => {
  const clock = verifierClock();
  let probes = 0;
  let reconciliations = 0;
  for (const value of [null, "not a url", "https://user:password@wake.example/topic"]) {
    const verifier = new WakeChannelVerifier({
      source: { matches: () => false, reconcile: () => { reconciliations += 1; } },
      configuration: verifiedWakeConfiguration(value),
      probe: async () => { probes += 1; return { verified: true }; },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    assert.deepEqual(await verifier.start(), { checked: false });
    assert.equal(verifier.status().enabled, false);
    await verifier.stop();
  }
  assert.equal(probes, 0);
  assert.equal(reconciliations, 0);
  assert.equal(clock.timers.length, 0);
});

test("a slow independent channel check does not interrupt normal queue processing", async () => {
  let releaseProbe;
  const probe = new Promise((resolve) => { releaseProbe = resolve; });
  let commands = 0;
  let triage = 0;
  let dispatch = 0;
  const worker = new WorkerLoop({
    service: {
      addToDepot: async () => ({ item: { id: "item" } }),
      engine: {
        runTriage: async () => { triage += 1; return { triaged: 0 }; },
        runDispatch: async () => { dispatch += 1; return { executed: 0 }; },
      },
    },
    commandQueue: {
      claimRemoteCommand: async () => commands++ === 0
        ? { id: "command", kind: "intake", payload: {} } : null,
      finishRemoteCommand: async () => {},
    },
  });
  const verifier = new WakeChannelVerifier({
    source: { matches: () => true, reconcile: () => {} },
    configuration: verifiedWakeConfiguration("https://wake.example/operator-topic/json"),
    probe: async () => probe,
  });

  const checking = verifier.start();
  const cycle = await worker.tick();
  assert.equal(cycle.remote_commands, 1);
  assert.equal(triage, 1);
  assert.equal(dispatch, 1);
  assert.equal(verifier.status().running, true);
  releaseProbe({ verified: true });
  await checking;
  await verifier.stop();
  await worker.stop();
});

test("stopping an in-flight channel check prevents late reconciliation", async () => {
  let releaseProbe;
  const probe = new Promise((resolve) => { releaseProbe = resolve; });
  let reconciliations = 0;
  const verifier = new WakeChannelVerifier({
    source: { matches: () => false, reconcile: () => { reconciliations += 1; } },
    configuration: verifiedWakeConfiguration("https://wake.example/operator-topic/json"),
    probe: async () => probe,
  });
  verifier.start();
  const stopped = verifier.stop();
  releaseProbe({ verified: true });
  await stopped;
  assert.equal(reconciliations, 0);
  assert.equal(verifier.status().next_check_at, null);
});
