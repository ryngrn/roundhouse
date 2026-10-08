import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { harness } from "./support/harness.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { startRoundhouseServer } from "../src/server/app-server.js";
import { startFrontDoor } from "../src/server/front-door.js";
import { WorkerLoop } from "../src/server/worker.js";
import { record } from "../src/workflow/state.js";
import { Store } from "../src/workflow/store.js";
import { statusView } from "../src/workflow/views.js";

function request(base, pathname, { method = "GET", body, host = "roundhouse" } = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { host, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, type: response.headers["content-type"], text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
}

class BrowserElement {
  constructor(tagName = "") {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.submissions = [];
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.dataset = {};
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { this.reportedValidity = true; }
  requestSubmit() {
    const submission = Promise.resolve(this.listeners.get("submit")?.({ preventDefault() {} }));
    this.submissions.push(submission);
    return submission;
  }
  showModal() {}
  close() {}
}

function browserDocument() {
  const elements = new Map();
  return {
    elements,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new BrowserElement());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    createElement(tagName) { return new BrowserElement(tagName); },
  };
}

function pressKey(element, properties) {
  let prevented = false;
  element.listeners.get("keydown")({ ...properties, preventDefault() { prevented = true; } });
  return prevented;
}

async function settleUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Browser client did not settle in time.");
}

function needsControls(document) {
  const card = document.querySelector("#needs-list").children[0];
  const form = card?.children.find((child) => child.tagName === "form");
  return { form, input: form?.children[0], button: form?.children[1] };
}

test("local server: protected UI, health, API, worker, evidence, config, and notifications form one slice", async (t) => {
  const h = harness({ policy: { shipping: "deploy" }, deployment: { kind: "fixture", environment: "preview" } });
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const running = await startRoundhouseServer({ service, port: 0, autoStartWorker: false });
  t.after(() => running.close());

  const forbidden = await request(running.url, "/health", { host: "attacker.invalid" });
  assert.equal(forbidden.status, 403);
  const page = await request(running.url, "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /Roundhouse Control Room/);
  assert.match(page.text, /Needs a signal/);
  assert.match(page.text, /Project configuration/);
  assert.match(page.text, /New project/);
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

  const initiated = await request(running.url, "/api/projects", {
    method: "POST",
    body: { outcome: "Create a calm reading tracker", name: "Quiet Pages", success_state: "A usable reading log exists", trusted: true },
  });
  assert.equal(initiated.status, 201);
  assert.equal(initiated.json().project_candidate.name, "Quiet Pages");
  assert.equal(initiated.json().project_candidate.executable, false);
  assert.equal(initiated.json().project_candidate.project_brief.trusted, true);
  const projectItem = h.store.read().items[initiated.json().item.id];
  assert.equal(projectItem.project_candidate_id, initiated.json().project_candidate.id);
  assert.equal(projectItem.input.metadata.kind, "project_initiation");
  assert.match(projectItem.input.text, /I trust Roundhouse/);
});

test("project initiation validates the outcome and infers a candidate name for delegated setup", async (t) => {
  const h = harness();
  const running = await startRoundhouseServer({ service: new RoundhouseService({ store: h.store, engine: h.engine }), port: 0, autoStartWorker: false });
  t.after(() => running.close());

  const invalid = await request(running.url, "/api/projects", { method: "POST", body: { trusted: true } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json().error, /requires an outcome/i);

  const inferred = await request(running.url, "/api/projects", { method: "POST", body: { outcome: "Build a gracious household inventory.", trusted: true } });
  assert.equal(inferred.status, 201);
  assert.equal(inferred.json().project_candidate.name, "a gracious household inventory");
  assert.equal(inferred.json().item.project_candidate.name, "a gracious household inventory");
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

test("local front door proxies only the canonical roundhouse host", async (t) => {
  const h = harness();
  const app = await startRoundhouseServer({ service: new RoundhouseService({ store: h.store, engine: h.engine }), port: 0, autoStartWorker: false });
  t.after(() => app.close());
  const appPort = new URL(app.url).port;
  const front = await startFrontDoor({ port: 0, targetPort: Number(appPort) });
  t.after(() => new Promise((resolve, reject) => front.close((error) => error ? reject(error) : resolve())));
  const address = front.address();
  const url = `http://127.0.0.1:${address.port}`;
  assert.equal((await request(url, "/", { host: "roundhouse" })).status, 200);
  assert.equal((await request(url, "/", { host: "localhost" })).status, 403);
});

test("front door returns structured JSON when the app service is unavailable", async (t) => {
  const front = await startFrontDoor({ port: 0, targetPort: 65534 });
  t.after(() => new Promise((resolve, reject) => front.close((error) => error ? reject(error) : resolve())));
  const address = front.address();
  const url = `http://127.0.0.1:${address.port}`;
  const apiResponse = await request(url, "/api/overview", { host: "roundhouse" });
  assert.equal(apiResponse.status, 503);
  assert.match(apiResponse.type, /application\/json/);
  assert.equal(apiResponse.json().code, "service_unavailable");
  assert.match(apiResponse.json().error, /service unavailable/i);
  const pageResponse = await request(url, "/", { host: "roundhouse" });
  assert.equal(pageResponse.status, 503);
  assert.match(pageResponse.type, /text\/plain/);
});

test("served browser client gives Depot textarea conversational keyboard behavior", async (t) => {
  const h = harness();
  const running = await startRoundhouseServer({ service: new RoundhouseService({ store: h.store, engine: h.engine }), port: 0, autoStartWorker: false });
  t.after(() => running.close());
  const script = await request(running.url, "/app.js");
  assert.equal(script.status, 200);

  const document = browserDocument();
  const browserFetch = async (pathname, options = {}) => {
    const response = await request(running.url, pathname, {
      method: options.method,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    });
    return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.json() };
  };
  vm.runInNewContext(script.text, {
    document,
    fetch: browserFetch,
    crypto: {},
    setInterval: () => 1,
    setTimeout: () => 1,
  }, { filename: "served-app.js" });

  const form = document.querySelector("#intake-form");
  const content = document.querySelector("#intake-content");
  const hint = document.querySelector("#project-hint");
  const message = document.querySelector("#intake-message");

  content.value = "first line";
  assert.equal(pressKey(content, { key: "Enter", shiftKey: true, isComposing: false }), false);
  assert.equal(form.submissions.length, 0);
  assert.equal(content.value, "first line");

  assert.equal(pressKey(content, { key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(form.submissions.length, 0);
  assert.equal(document.querySelector("#config-editor").listeners.has("keydown"), false);

  const tooLong = "x".repeat(100_001);
  content.value = tooLong;
  hint.value = "example";
  assert.equal(pressKey(content, { key: "Enter", shiftKey: false, isComposing: false }), true);
  await Promise.all(form.submissions);
  assert.equal(message.textContent, "Intake content exceeds 100,000 characters.");
  assert.equal(content.value, tooLong);
  assert.equal(hint.value, "example");

  content.value = "ship from a browser without secure-context crypto";
  hint.value = "example";
  assert.equal(pressKey(content, { key: "Enter", shiftKey: false, isComposing: false }), true);
  await Promise.all(form.submissions);

  const [item] = Object.values(h.store.read().items);
  assert.equal(item.input.project_hint, "example");
  assert.match(message.textContent, new RegExp(`^Saved ${item.id}\\. The local worker will pick it up\\.$`));
  assert.equal(content.value, "");
  assert.equal(hint.value, "");

  content.value = "button submission still works";
  hint.value = "example";
  await form.listeners.get("submit")({ preventDefault() {} });
  assert.equal(Object.values(h.store.read().items).length, 2);
  assert.equal(content.value, "");

  await form.listeners.get("submit")({ preventDefault() {} });
  assert.equal(message.textContent, "Intake requires nonempty content.");
});

test("served browser client uses one explicit atomic decision-session submission", async (t) => {
  const h = harness();
  const running = await startRoundhouseServer({ service: new RoundhouseService({ store: h.store, engine: h.engine }), port: 0, autoStartWorker: false });
  t.after(() => running.close());
  const script = await request(running.url, "/app.js");
  assert.match(script.text, /Submit \$\{questions\.length\} answer/);
  assert.match(script.text, /expected_item_revision/);
  assert.match(script.text, /decision-session/);
  assert.doesNotMatch(script.text, /submitOnEnter\(input/);
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
