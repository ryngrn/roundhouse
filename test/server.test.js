import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { harness } from "./support/harness.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { startRoundhouseServer } from "../src/server/app-server.js";
import { WorkerLoop } from "../src/server/worker.js";
import { Store } from "../src/workflow/store.js";

function request(base, pathname, { method = "GET", body, host } = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { ...(host ? { host } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
}

test("local server: hosted redirect, health, API, worker, evidence, config, and notifications form one slice", async (t) => {
  const h = harness({ policy: { shipping: "deploy" }, deployment: { kind: "fixture", environment: "preview" } });
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const running = await startRoundhouseServer({ service, port: 0, autoStartWorker: false });
  t.after(() => running.close());

  const forbidden = await request(running.url, "/health", { host: "attacker.invalid" });
  assert.equal(forbidden.status, 403);
  const page = await request(running.url, "/");
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, "https://roundhouse.ryan.green");
  assert.equal((await request(running.url, "/health")).json().status, "ok");

  const added = await request(running.url, "/api/intake", {
    method: "POST",
    body: { content: "ship from the control room", project_hint: "example", idempotency_key: "server-test" },
  });
  assert.equal(added.status, 201);
  assert.equal(added.json().item.state, "Depot");
  const tick = await request(running.url, "/api/worker/tick", { method: "POST", body: {} });
  assert.equal(tick.status, 200);
  assert.equal(tick.json().executed, 1);
  assert.ok(tick.json().worker.last_dispatch);
  assert.equal(tick.json().worker.dispatch_error, null);

  const overview = (await request(running.url, "/api/overview")).json();
  assert.equal(overview.counts.completed, 1);
  assert.equal(overview.items[0].state, "Shipped");
  assert.ok(overview.items[0].evidence.checks.every((check) => check.passed));
  assert.equal(overview.items[0].evidence.deliveries[0].deployment.status, "succeeded");
  assert.equal(overview.connection.mcp, "available");

  const notices = (await request(running.url, "/api/notifications")).json();
  assert.ok(notices.notifications.some((notice) => notice.kind === "completion"));
  const noDuplicates = (await request(running.url, `/api/notifications?after=${notices.cursor}`)).json();
  assert.deepEqual(noDuplicates.notifications, []);

  const config = (await request(running.url, "/api/config")).json();
  config.configuration.projects[0].weight = 3;
  const saved = await request(running.url, "/api/config", { method: "PUT", body: { configuration: config.configuration } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json().configuration.projects[0].weight, 3);
});

test("server startup safely recovers a dead local worker lock before dispatch", async (t) => {
  const h = harness();
  const item = h.submit("Preserve interrupted work during stale-lock recovery", "stale-worker-lock");
  h.store.change((data) => h.store.move(data, data.items[item.id], "Decision", "Interrupted decision in progress."));
  fs.mkdirSync(h.store.workerLock, { mode: 0o700 });
  fs.writeFileSync(`${h.store.workerLock}/owner.json`, JSON.stringify({
    pid: 99_999_999, hostname: os.hostname(), token: "dead-worker", at: "2026-10-08T00:00:00.000Z",
  }), { mode: 0o600 });

  const running = await startRoundhouseServer({
    stateDirectory: h.store.directory, configFile: h.configFile, port: 0,
    autoStartWorker: false, relayConnectionString: null,
  });
  t.after(() => running.close());
  assert.equal(fs.existsSync(h.store.workerLock), false);
  const overview = (await request(running.url, "/api/overview")).json();
  assert.equal(overview.items[0].state, "Blocked");
  assert.match(overview.items[0].reason, /Interrupted attempt/);
});

test("local snapshot explicitly refreshes external durable changes without waking the worker", async (t) => {
  const h = harness();
  const item = h.submit("Observe an external durable update", "local-snapshot-refresh");
  h.store.change((data) => {
    h.store.move(data, data.items[item.id], "Decision", "Ready for an external decision.");
    h.store.move(data, data.items[item.id], "Needs Clarification", "An initial signal is needed.");
  });
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const worker = new WorkerLoop({ service });
  let wakeCount = 0;
  const wake = worker.wake.bind(worker);
  worker.wake = (...args) => {
    wakeCount += 1;
    return wake(...args);
  };
  const running = await startRoundhouseServer({ service, worker, port: 0, autoStartWorker: false });
  t.after(() => running.close());

  const first = (await request(running.url, "/api/local-snapshot")).json();
  assert.equal(first.items[0].state, "Needs Clarification");
  assert.equal(first.notifications.at(-1).state, "Needs Clarification");
  assert.ok(first.cursor);

  const externalStore = new Store(h.store.directory);
  externalStore.change((data) => {
    externalStore.move(data, data.items[item.id], "Blocked", "External durable state changed.");
  });

  const second = (await request(running.url, `/api/local-snapshot?after=${encodeURIComponent(first.cursor)}`)).json();
  assert.equal(second.items[0].state, "Blocked");
  assert.deepEqual(second.notifications.map((notice) => ({ state: notice.state, message: notice.message })), [
    { state: "Blocked", message: "External durable state changed." },
  ]);
  assert.notEqual(second.cursor, first.cursor);
  assert.equal(wakeCount, 0);
  assert.equal(worker.status().last_run, null);
});

test("local server rejects malformed configuration without overwriting the private file", async (t) => {
  const h = harness();
  const before = await import("node:fs").then((fs) => fs.readFileSync(h.configFile, "utf8"));
  const running = await startRoundhouseServer({ service: new RoundhouseService({ store: h.store, engine: h.engine }), port: 0, autoStartWorker: false });
  t.after(() => running.close());
  const response = await request(running.url, "/api/config", { method: "PUT", body: { configuration: { projects: [{ id: "bad" }] } } });
  assert.equal(response.status, 400);
  const after = await import("node:fs").then((fs) => fs.readFileSync(h.configFile, "utf8"));
  assert.equal(after, before);
});

test("decision-session endpoint returns structured conflict and applies zero stale answers", async (t) => {
  const h = harness();
  const item = h.submit("ambiguous batch endpoint");
  await h.engine.decide(item.id);
  const before = h.store.read().items[item.id];
  const question = before.questions.find((candidate) => candidate.status === "open");
  const running = await startRoundhouseServer({ service: new RoundhouseService({ store: h.store, engine: h.engine }), port: 0, autoStartWorker: false });
  t.after(() => running.close());
  const response = await request(running.url, `/api/items/${item.id}/decision-session`, { method: "POST", body: {
    expected_item_revision: before.revision + 1,
    answers: [{ question_id: question.id, expected_revision: question.revision, answer: "A complete but stale answer" }],
  } });
  assert.equal(response.status, 409);
  assert.equal(response.json().code, "decision_session_conflict");
  assert.equal(response.json().conflict.item_id, item.id);
  const after = h.store.read().items[item.id];
  assert.equal(after.questions.find((candidate) => candidate.id === question.id).status, "open");
  assert.equal(after.clarifications.length, 0);
});
