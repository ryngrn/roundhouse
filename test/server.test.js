import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { harness } from "./support/harness.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { startRoundhouseServer } from "../src/server/app-server.js";
import { startFrontDoor } from "../src/server/front-door.js";

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
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
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
  assert.match(page.text, /Needs You/);
  assert.match(page.text, /Project configuration/);
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

test("served browser client preserves Needs You answers until keyboard submission succeeds", async (t) => {
  const h = harness();
  const item = h.submit("ambiguous browser clarification");
  await h.engine.decide(item.id);
  assert.equal(h.store.read().items[item.id].state, "Needs Clarification");

  const running = await startRoundhouseServer({ service: new RoundhouseService({ store: h.store, engine: h.engine }), port: 0, autoStartWorker: false });
  t.after(() => running.close());
  const script = await request(running.url, "/app.js");
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
    setInterval: () => 1,
    setTimeout: () => 1,
  }, { filename: "served-app.js" });

  await settleUntil(() => needsControls(document).form);
  let { form, input } = needsControls(document);
  input.value = "first line";
  input.listeners.get("input")();
  assert.equal(pressKey(input, { key: "Enter", shiftKey: true, isComposing: false }), false);
  assert.equal(form.submissions.length, 0);
  assert.equal(input.value, "first line");

  const questionId = h.store.read().items[item.id].questions[0].id;
  h.store.change((data) => { data.items[item.id].questions[0].revision += 1; });
  input.value = "preserve this answer";
  input.listeners.get("input")();
  assert.equal(pressKey(input, { key: "Enter", shiftKey: false, isComposing: false }), true);
  await Promise.all(form.submissions);
  assert.equal(input.value, "preserve this answer");
  assert.match(input.validationMessage, /stale|already resolved/);
  assert.equal(input.reportedValidity, true);

  await document.querySelector("#refresh").listeners.get("click")();
  ({ form, input } = needsControls(document));
  assert.equal(input.value, "preserve this answer");

  assert.equal(pressKey(input, { key: "Enter", shiftKey: false, isComposing: false }), true);
  pressKey(input, { key: "Enter", shiftKey: false, isComposing: false });
  await Promise.all(form.submissions);
  const answered = h.store.read().items[item.id];
  assert.equal(answered.clarifications.filter((entry) => entry.question_id === questionId).length, 1);
  assert.equal(answered.clarifications.at(-1).text, "preserve this answer");
  assert.equal(input.value, "");
  assert.equal(document.querySelector("#needs-list").children[0].textContent, "Nothing needs you.");
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
