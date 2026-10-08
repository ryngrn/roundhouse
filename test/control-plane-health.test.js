import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneHealthScheduler } from "../src/server/control-plane-health.js";

function fakeClock(initial = Date.parse("2026-06-01T00:00:00.000Z")) {
  let now = initial;
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
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("control-plane health runs immediately, stores success evidence, and schedules daily without workflow work", async () => {
  const clock = fakeClock();
  let checks = 0;
  const store = {
    getControlPlaneHealthEvidence: async () => null,
    runControlPlaneHealthCheck: async () => {
      checks += 1;
      return { last_success_at: new Date(clock.now()).toISOString() };
    },
  };
  const scheduler = new ControlPlaneHealthScheduler({ store, now: clock.now, setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn });

  await scheduler.start();

  assert.equal(checks, 1);
  assert.equal(scheduler.status().last_success_at, "2026-06-01T00:00:00.000Z");
  assert.equal(clock.timers[0].delay, 24 * 60 * 60 * 1000);
  assert.equal(scheduler.status().last_error, null);
  await scheduler.stop();
});

test("control-plane health reconstructs the remaining daily delay after restart", async () => {
  const clock = fakeClock(Date.parse("2026-06-01T12:00:00.000Z"));
  let checks = 0;
  const scheduler = new ControlPlaneHealthScheduler({
    store: {
      getControlPlaneHealthEvidence: async () => ({ last_success_at: "2026-06-01T00:00:00.000Z" }),
      runControlPlaneHealthCheck: async () => { checks += 1; return { last_success_at: new Date(clock.now()).toISOString() }; },
    },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  await scheduler.start();

  assert.equal(checks, 0);
  assert.equal(clock.timers[0].delay, 12 * 60 * 60 * 1000);
  assert.equal(scheduler.status().next_check_at, "2026-06-02T00:00:00.000Z");
  await scheduler.stop();
});

test("control-plane health reports failures and retries with bounded exponential backoff", async () => {
  const clock = fakeClock();
  const errors = [];
  let checks = 0;
  const scheduler = new ControlPlaneHealthScheduler({
    store: {
      getControlPlaneHealthEvidence: async () => null,
      runControlPlaneHealthCheck: async () => {
        checks += 1;
        if (checks < 3) throw new Error(`database unavailable ${checks}`);
        return { last_success_at: new Date(clock.now()).toISOString() };
      },
    },
    onError: (error) => errors.push(error.message),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    minimumBackoffMs: 100,
    maximumBackoffMs: 150,
  });

  await scheduler.start();
  assert.equal(clock.timers[0].delay, 100);
  await clock.fire(clock.timers[0]);
  assert.equal(clock.timers[1].delay, 150);
  await clock.fire(clock.timers[1]);

  assert.deepEqual(errors, ["database unavailable 1", "database unavailable 2"]);
  assert.equal(scheduler.status().consecutive_failures, 0);
  assert.equal(scheduler.status().last_error, null);
  assert.equal(clock.timers[2].delay, 24 * 60 * 60 * 1000);
  await scheduler.stop();
});

test("control-plane health remains disabled for stores without the PostgreSQL health contract", async () => {
  const clock = fakeClock();
  const scheduler = new ControlPlaneHealthScheduler({ store: {}, now: clock.now, setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn });
  await scheduler.start();
  assert.equal(scheduler.status().enabled, false);
  assert.deepEqual(clock.timers, []);
});
