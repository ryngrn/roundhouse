import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { deriveRelayHealth, RelayHealthMonitor, RELAY_STATES } from "../src/server/relay-health.js";
import { HttpWakeSource } from "../src/server/wake-source.js";
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
