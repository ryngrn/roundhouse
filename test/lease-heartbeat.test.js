import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startLeaseHeartbeat } from "../src/workflow/lease-heartbeat.js";
import { monitorIdlePoolErrors } from "../src/storage/postgres.js";

function controlled(store, leases, options = {}) {
  let scheduled;
  let cancelled = false;
  const monitor = startLeaseHeartbeat(store, leases, {
    schedule: (fn) => { scheduled = fn; return { unref() {} }; },
    unschedule: () => { cancelled = true; },
    ...options,
  });
  return { ...monitor, fire: () => scheduled(), get cancelled() { return cancelled; } };
}

test("PostgreSQL idle client errors are logged without terminating the process or leaking secrets", () => {
  const pool = new EventEmitter();
  const reports = [];
  monitorIdlePoolErrors(pool, (message) => reports.push(message));
  assert.doesNotThrow(() => pool.emit("error", Object.assign(new Error("secret=private"), { code: "ECONNRESET" })));
  assert.equal(reports.length, 1);
  assert.match(reports[0], /idle client disconnected.*ECONNRESET/);
  assert.doesNotMatch(reports[0], /secret=private/);
});

test("node presence failures do not invalidate a correctly renewed lease", async () => {
  let renewals = 0;
  let presences = 0;
  const monitor = controlled({
    leaseMs: 60000,
    heartbeatLease: async () => { renewals++; },
    heartbeatNode: async () => { presences++; throw new Error("status endpoint temporarily unavailable"); },
  }, [{ token: "owner", resource_key: "item" }]);
  await monitor.tick();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(renewals, 1);
  assert.equal(presences, 1);
  assert.doesNotThrow(() => monitor.assertHealthy());
  await monitor.tick();
  assert.equal(renewals, 2);
  await monitor.stop();
  assert.equal(monitor.cancelled, true);
});

test("slow lease renewals are single-flight rather than creating overlapping queries", async () => {
  let complete;
  const gate = new Promise((resolve) => { complete = resolve; });
  let calls = 0;
  const monitor = controlled({
    leaseMs: 60000,
    heartbeatLease: () => { calls++; return calls === 1 ? gate : Promise.resolve(); },
    heartbeatNode: async () => {},
  }, [{ token: "owner" }]);
  const first = monitor.tick();
  await monitor.tick();
  assert.equal(calls, 1);
  complete();
  await first;
  await monitor.tick();
  assert.equal(calls, 2);
  await monitor.stop();
});

test("transient PostgreSQL connection timeout permits bounded lease renewal retry", async () => {
  let clock = 0;
  let attempts = 0;
  const monitor = controlled({
    leaseMs: 60_000,
    heartbeatLease: async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("timeout exceeded when trying to connect"), { code: "ETIMEDOUT" });
    },
  }, [{ token: "owner" }], { now: () => clock });
  clock = 20_000;
  await monitor.tick();
  assert.doesNotThrow(() => monitor.assertHealthy());
  clock = 40_000;
  await monitor.tick();
  assert.equal(attempts, 2);
  assert.doesNotThrow(() => monitor.assertHealthy());
  await monitor.stop();
});

test("transient transport failures cannot outlive the last confirmed lease", async () => {
  let clock = 0;
  const monitor = controlled({
    leaseMs: 60_000,
    heartbeatLease: async () => { throw Object.assign(new Error("connection down"), { code: "ECONNRESET" }); },
  }, [{ token: "owner" }], { now: () => clock });
  clock = 20_000;
  await monitor.tick();
  assert.doesNotThrow(() => monitor.assertHealthy());
  clock = 60_000;
  assert.throws(() => monitor.assertHealthy(), /Lease renewal not confirmed/);
  await monitor.tick();
  await assert.rejects(monitor.stop(), /connection down/);
});

test("lost ownership fails closed and prevents additional renewals", async () => {
  let calls = 0;
  const monitor = controlled({
    leaseMs: 60000,
    heartbeatLease: async () => { calls++; throw new Error("Lease lost: item/sample"); },
    heartbeatNode: async () => {},
  }, [{ token: "stale" }]);
  await monitor.tick();
  assert.throws(() => monitor.assertHealthy(), /Lease lost: item\/sample/);
  await monitor.tick();
  assert.equal(calls, 1);
  await assert.rejects(monitor.stop(), /Lease lost: item\/sample/);
});

test("stop waits for pending renewal and does not start work afterward", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const monitor = controlled({
    leaseMs: 60000,
    heartbeatLease: () => { calls++; return gate; },
    heartbeatNode: async () => {},
  }, [{ token: "worker" }]);
  monitor.fire();
  const stopped = monitor.stop();
  await Promise.resolve();
  assert.equal(monitor.cancelled, true);
  monitor.fire();
  assert.equal(calls, 1);
  release();
  await stopped;
});
