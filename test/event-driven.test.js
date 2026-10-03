import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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

test("wake stream ignores open/keepalive events and reconnects without creating work", async (t) => {
  let connections = 0;
  let cycles = 0;
  const stream = http.createServer((_request, response) => {
    connections += 1;
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    if (connections === 1) response.end('{"event":"open"}\n{"event":"keepalive"}\n{"event":"message"}\n{"event":"message"}\n');
    else response.end('{"event":"open"}\n{"event":"keepalive"}\n');
  });
  await new Promise((resolve) => stream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => stream.close(resolve)));
  const store = { shared: true, claimRemoteCommand: async () => null };
  const worker = new WorkerLoop({ service: { store, engine: {
    store,
    runTriage: async () => { cycles += 1; return { triaged: 0 }; },
    runDispatch: async () => ({ executed: 0 }),
  } } });
  const source = new HttpWakeSource({
    url: `http://127.0.0.1:${stream.address().port}/topic/json`, wake: () => worker.wake(),
    minimumBackoffMs: 5, maximumBackoffMs: 10,
  });
  t.after(() => { source.stop(); worker.stop(); });
  source.start();
  await waitFor(() => connections >= 2);
  await waitFor(() => cycles === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cycles, 1);
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

