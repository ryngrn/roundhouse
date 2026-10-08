import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import test from "node:test";
import { harness } from "./support/harness.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { startRoundhouseServer } from "../src/server/app-server.js";
import { WorkerLoop } from "../src/server/worker.js";
import { HttpWakeSource } from "../src/server/wake-source.js";
import { PostgresRelay, RelayProjectionPublisher } from "../src/relay/postgres-relay.js";

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not settle");
};

const fakeTimers = (initialNow = Date.parse("2026-01-01T00:00:00.000Z")) => {
  let currentNow = initialNow;
  const timers = [];
  const cleared = [];
  return {
    timers,
    cleared,
    now: () => currentNow,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, active: true, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.active = false;
      cleared.push(timer);
    },
    fire(timer) {
      assert.equal(timer.active, true, "timer must be active before it fires");
      timer.active = false;
      currentNow += timer.delay;
      timer.callback();
    },
  };
};

class FakeResponse extends EventEmitter {
  constructor(statusCode) {
    super();
    this.statusCode = statusCode;
    this.destroyed = false;
    this.resumed = false;
  }

  setEncoding() {}
  resume() { this.resumed = true; }
  destroy() { this.destroyed = true; }
  send(value) { this.emit("data", value); }
  end() { this.emit("end"); }
}

test("WorkerLoop startup uses one wake and installs no recurring timer", async () => {
  let intervals = 0;
  const original = globalThis.setInterval;
  globalThis.setInterval = () => { intervals += 1; return { unref() {} }; };
  try {
    let triage = 0;
    const store = { shared: true, claimRemoteCommand: async () => null };
    const worker = new WorkerLoop({ service: { store, engine: {
      store,
      runTriage: async () => { triage += 1; return { triaged: 0 }; },
      runDispatch: async () => ({ executed: 0 }),
    } } });
    await worker.start();
    assert.equal(intervals, 0);
    assert.equal(triage, 1);
    worker.stop();
  } finally { globalThis.setInterval = original; }
});

test("duplicate wakes coalesce and a wake during an active cycle schedules one follow-up", async () => {
  let release;
  let calls = 0;
  const firstCycle = new Promise((resolve) => { release = resolve; });
  const store = { shared: true, claimRemoteCommand: async () => null };
  const worker = new WorkerLoop({ service: { store, engine: {
    store,
    runTriage: async () => { calls += 1; if (calls === 1) await firstCycle; return { triaged: 0 }; },
    runDispatch: async () => ({ executed: 0 }),
  } } });
  const startup = worker.start();
  await waitFor(() => calls === 1);
  const duplicateA = worker.wake();
  const duplicateB = worker.wake();
  release();
  await Promise.all([startup, duplicateA, duplicateB]);
  assert.equal(calls, 2);
  worker.stop();
});

test("a sustained wake burst is rate limited after one coalesced follow-up", async () => {
  const releases = [];
  const timers = [];
  let calls = 0;
  const worker = new WorkerLoop({
    service: { engine: {
      runTriage: async () => {
        calls += 1;
        if (calls <= 2) await new Promise((resolve) => releases.push(resolve));
        return { triaged: 0 };
      },
      runDispatch: async () => ({ executed: 0 }),
    } },
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });

  const startup = worker.start();
  await waitFor(() => calls === 1);
  worker.wake();
  releases.shift()();
  await waitFor(() => calls === 2);
  worker.wake();
  worker.wake();
  releases.shift()();
  await startup;

  assert.equal(calls, 2);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1_000);
  assert.equal(worker.status().wake_pending, true);

  timers[0].callback();
  await waitFor(() => calls === 3);
  assert.equal(worker.status().wake_pending, false);
  await worker.stop();
});

test("scheduled one-shot wake is reconstructed from durable eligibility after restart", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const wakeAt = "2026-01-01T01:00:00.000Z";
  const timers = [];
  const cleared = [];
  const setTimeoutFn = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  };
  const clearTimeoutFn = (timer) => cleared.push(timer);
  const store = { shared: true, claimRemoteCommand: async () => null };
  const engine = {
    store,
    runTriage: async () => ({ triaged: 0 }),
    runDispatch: async () => ({ executed: 0 }),
    nextScheduledWake: async () => wakeAt,
  };

  const first = new WorkerLoop({ service: { store, engine }, setTimeoutFn, clearTimeoutFn, now: () => now });
  await first.start();
  assert.equal(first.status().next_scheduled_wake_at, wakeAt);
  assert.equal(timers[0].delay, 60 * 60 * 1000);
  await first.stop();
  assert.deepEqual(cleared, [timers[0]]);

  const restarted = new WorkerLoop({ service: { store, engine }, setTimeoutFn, clearTimeoutFn, now: () => now });
  await restarted.start();
  assert.equal(restarted.status().next_scheduled_wake_at, wakeAt);
  assert.equal(timers[1].delay, 60 * 60 * 1000);
  await restarted.stop();
});

test("wake stream ignores open/keepalive events and reconnects without creating work", async () => {
  const requests = [];
  const clock = fakeTimers();
  let cycles = 0;
  const store = { shared: true, claimRemoteCommand: async () => null };
  const worker = new WorkerLoop({ service: { store, engine: {
    store,
    runTriage: async () => { cycles += 1; return { triaged: 0 }; },
    runDispatch: async () => ({ executed: 0 }),
  } } });
  const source = new HttpWakeSource({
    url: "https://wake.example/topic/json",
    wake: () => worker.wake(),
    minimumBackoffMs: 5, maximumBackoffMs: 10,
    get: () => {
      const request = new EventEmitter();
      request.destroy = () => {};
      requests.push(request);
      return request;
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  source.start();

  const first = new FakeResponse(200);
  requests[0].emit("response", first);
  first.send('{"event":"open"}\n{"event":"keepalive"}\n{"event":"message"}\n{"event":"message"}\n');
  await worker.wakeDrain;
  assert.equal(cycles, 1);

  first.end();
  clock.fire(clock.timers[0]);
  const second = new FakeResponse(200);
  requests[1].emit("response", second);
  second.send('{"event":"open"}\n{"event":"keepalive"}\n');
  await Promise.resolve();
  assert.equal(cycles, 1);

  source.stop();
  await worker.stop();
});

test("wake stream deterministically recovers from errors and clean closes with bounded jitter reset", () => {
  const requests = [];
  const clock = fakeTimers();
  let wakes = 0;
  const source = new HttpWakeSource({
    url: "https://wake.example/topic/json",
    wake: () => { wakes += 1; },
    minimumBackoffMs: 100,
    maximumBackoffMs: 250,
    random: () => 0.5,
    get: (_url, options) => {
      const request = new EventEmitter();
      request.destroyed = false;
      request.destroy = () => { request.destroyed = true; };
      requests.push({ request, options });
      return request;
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  source.start();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.accept, "application/x-ndjson, application/json");

  requests[0].request.emit("error", new Error("socket closed"));
  assert.equal(clock.timers[0].delay, 75);
  source.disconnected();
  assert.equal(clock.timers.length, 1, "repeated failure signals share one pending retry");

  clock.fire(clock.timers[0]);
  const rejected = new FakeResponse(503);
  requests[1].request.emit("response", rejected);
  assert.equal(rejected.resumed, true);
  assert.equal(clock.timers[1].delay, 150);

  clock.fire(clock.timers[1]);
  const cleanClose = new FakeResponse(200);
  requests[2].request.emit("response", cleanClose);
  cleanClose.end();
  assert.equal(clock.timers[2].delay, 187, "retry delay stays below the 250ms ceiling");

  clock.fire(clock.timers[2]);
  const recovered = new FakeResponse(200);
  requests[3].request.emit("response", recovered);
  recovered.send('{"event":"message"}\n');
  assert.equal(wakes, 1);
  recovered.end();
  assert.equal(clock.timers[3].delay, 75, "a useful message resets the failure streak");

  clock.fire(clock.timers[3]);
  assert.equal(requests.length, 5, "the source reconnects after recovery closes");
  source.connect();
  assert.equal(requests.length, 5, "only one live subscription is allowed");
  assert.equal(source.reconnectTimer, null);
  source.stop();
  assert.equal(requests[4].request.destroyed, true);
});

test("five-minute relay reconciliation survives wake/database mismatch, outage, recovery, and restart", async () => {
  const clock = fakeTimers();
  const commands = [];
  const finished = [];
  let databaseOffline = false;
  let triage = 0;
  let dispatch = 0;
  const queue = {
    claimRemoteCommand: async () => {
      if (databaseOffline) throw new Error("relay database offline");
      return commands.shift() ?? null;
    },
    finishRemoteCommand: async (id, result) => finished.push([id, result]),
  };
  const service = {
    addToDepot: async (payload) => ({ item: { id: payload.id } }),
    engine: {
      runTriage: async () => { triage += 1; return { triaged: 0 }; },
      runDispatch: async () => { dispatch += 1; return { executed: 0 }; },
    },
  };
  const timerOptions = { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn, now: clock.now };

  const first = new WorkerLoop({ service, commandQueue: queue, ...timerOptions });
  await first.start();
  assert.equal(clock.timers[0].delay, 5 * 60 * 1000);
  assert.equal(first.status().next_reconciliation_at, "2026-01-01T00:05:00.000Z");
  assert.equal(finished.length, 0, "an idle startup does not write a command result");

  await first.wake();
  assert.equal(finished.length, 0, "a wake that races ahead of its database commit stays idle");
  assert.equal(triage, 2);
  assert.equal(dispatch, 2);

  commands.push({ id: "during-outage", kind: "intake", payload: { id: "pending-1" } });
  databaseOffline = true;
  clock.fire(clock.timers[0]);
  await first.wakeDrain;
  assert.equal(finished.length, 0);
  assert.equal(triage, 3, "relay failure does not block one bounded local agent cycle");
  assert.equal(dispatch, 3);
  assert.equal(first.status().next_reconciliation_at, "2026-01-01T00:10:00.000Z");

  databaseOffline = false;
  clock.fire(clock.timers[1]);
  await first.wakeDrain;
  assert.equal(finished[0][0], "during-outage");
  assert.equal(triage, 4);
  assert.equal(dispatch, 4);
  assert.equal(first.status().next_reconciliation_at, "2026-01-01T00:15:00.000Z");
  await first.stop();
  assert.ok(clock.cleared.includes(clock.timers[2]));

  commands.push({ id: "after-restart", kind: "intake", payload: { id: "pending-2" } });
  const restarted = new WorkerLoop({ service, commandQueue: queue, ...timerOptions });
  await restarted.start();
  assert.equal(finished[1][0], "after-restart");
  assert.equal(restarted.status().next_reconciliation_at, "2026-01-01T00:15:00.000Z");
  assert.equal(clock.timers[3].delay, 5 * 60 * 1000);
  await restarted.stop();
  assert.ok(clock.cleared.includes(clock.timers[3]));
});

test("programmatic servers do not inherit the production relay environment", async (t) => {
  const h = harness();
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const previous = process.env.ROUNDHOUSE_RELAY_DATABASE_URL;
  process.env.ROUNDHOUSE_RELAY_DATABASE_URL = "postgresql://invalid.example/relay";
  try {
    const running = await startRoundhouseServer({ service, port: 0, autoStartWorker: false });
    t.after(() => running.close());
    assert.equal(running.worker.commandQueue, null);
  } finally {
    if (previous === undefined) delete process.env.ROUNDHOUSE_RELAY_DATABASE_URL;
    else process.env.ROUNDHOUSE_RELAY_DATABASE_URL = previous;
  }
});

test("health is local-only and polling guardrails remain absent", async (t) => {
  const h = harness();
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  service.getStorageStatus = () => { throw new Error("health touched authoritative storage"); };
  const running = await startRoundhouseServer({ service, port: 0, autoStartWorker: false });
  t.after(() => running.close());
  const health = await (await fetch(`${running.url}/health`)).json();
  assert.equal(health.status, "ok");
  assert.equal(health.storage.checked, false);

  const web = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  const mcp = fs.readFileSync(new URL("../src/mcp/http-server.js", import.meta.url), "utf8");
  assert.doesNotMatch(web, /setInterval\s*\(\s*load/);
  assert.doesNotMatch(mcp, /setInterval/);
});
test("local worker processes relay commands without making relay authoritative", async () => {
  const commands = [{ id: "command-1", kind: "intake", payload: { content: "Remote idea" } }];
  const finished = [];
  const queue = {
    claimRemoteCommand: async () => commands.shift() ?? null,
    finishRemoteCommand: async (id, result) => finished.push([id, result]),
  };
  let triage = 0;
  let dispatch = 0;
  const store = { shared: false };
  const service = {
    store,
    addToDepot: async (payload) => ({ item: { id: "local-item", payload } }),
    engine: {
      store,
      runTriage: async () => { triage += 1; return { triaged: 0 }; },
      runDispatch: async () => { dispatch += 1; return { executed: 0 }; },
    },
  };
  const worker = new WorkerLoop({ service, commandQueue: queue });
  const result = await worker.tick();
  assert.equal(result.remote_commands, 1);
  assert.equal(triage, 1);
  assert.equal(dispatch, 1);
  assert.equal(finished[0][0], "command-1");
  assert.equal(finished[0][1].result.item.id, "local-item");
});

test("one control-plane cycle caps remote command mutations", async () => {
  const commands = Array.from({ length: 5 }, (_, index) => ({
    id: `command-${index + 1}`, kind: "intake", payload: { content: `Idea ${index + 1}` },
  }));
  const finished = [];
  const queue = {
    claimRemoteCommand: async () => commands.shift() ?? null,
    finishRemoteCommand: async (id) => finished.push(id),
  };
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
    commandQueue: queue,
    maxRemoteCommandsPerCycle: 2,
  });

  const first = await worker.tick();
  assert.equal(first.remote_commands, 2);
  assert.equal(first.remote_command_limit_reached, true);
  assert.deepEqual(finished, ["command-1", "command-2"]);
  assert.equal(commands.length, 3);
  assert.equal(triage, 1);
  assert.equal(dispatch, 1);

  await worker.tick();
  assert.deepEqual(finished, ["command-1", "command-2", "command-3", "command-4"]);
  assert.equal(commands.length, 1);
  assert.equal(triage, 2);
  assert.equal(dispatch, 2);
});

test("relay outage never blocks local triage or dispatch", async () => {
  let triage = 0;
  let dispatch = 0;
  const store = { shared: false };
  const worker = new WorkerLoop({
    service: { store, engine: {
      store,
      runTriage: async () => { triage += 1; return { triaged: 0 }; },
      runDispatch: async () => { dispatch += 1; return { executed: 0 }; },
    } },
    commandQueue: { claimRemoteCommand: async () => { throw new Error("relay offline"); } },
  });
  const result = await worker.tick();
  assert.equal(triage, 1);
  assert.equal(dispatch, 1);
  assert.match(result.remote_command_error, /relay offline/);
});

test("relay stores one projection row instead of rewriting workflow tables", async () => {
  const sql = [];
  const pool = {
    query: async (statement) => {
      sql.push(statement);
      if (/RETURNING revision,updated_at/.test(statement)) return { rows: [{ revision: 2, updated_at: new Date() }] };
      return { rows: [] };
    },
    end: async () => {},
  };
  const relay = PostgresRelay.create({ pool });
  const result = await relay.publishProjection({ overview: { items: [] }, configuration: { projects: [] } });
  assert.equal(result.revision, 2);
  assert.equal(sql.length, 2);
  assert.match(sql[0], /CREATE TABLE IF NOT EXISTS roundhouse_relay\.dashboard_projection/);
  assert.match(sql[1], /INSERT INTO roundhouse_relay\.dashboard_projection/);
  assert.doesNotMatch(sql[1], /depot_items|jobs|questions|answers/);
});

test("projection publisher coalesces changes while a remote write is in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const published = [];
  let value = 0;
  const relay = {
    publishProjection: async (payload) => {
      published.push(payload.value);
      if (published.length === 1) await gate;
    },
  };
  const publisher = new RelayProjectionPublisher({ relay, project: async () => ({ value: ++value }) });
  const first = publisher.trigger();
  await waitFor(() => published.length === 1);
  publisher.trigger();
  publisher.trigger();
  release();
  await first;
  await waitFor(() => published.length === 2);
  assert.deepEqual(published, [1, 2]);
  publisher.stop();
});
