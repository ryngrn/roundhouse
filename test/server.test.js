import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import { harness } from "./support/harness.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { startRoundhouseServer } from "../src/server/app-server.js";
import { startFrontDoor } from "../src/server/front-door.js";
import { record } from "../src/workflow/state.js";
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

function elementText(element) {
  return [element?.textContent || "", ...(element?.children || []).map(elementText)].join(" ");
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

test("served browser client renders local and machine-local active jobs from the authoritative projection", async () => {
  const h = harness();
  const local = h.store.submit({ text: "Run local work", source: "test", actor: "test", project_id: "example" }, "active-local");
  const remote = h.store.submit({ text: "Update Kmac", source: "test", actor: "test", project_id: "kmac" }, "active-kmac");
  h.store.change((data) => {
    Object.assign(data.items[local.id], { state: "Ready", project_id: "example", job_ids: [`${local.id}-1`] });
    data.jobs[`${local.id}-1`] = record(`${local.id}-1`, { state: "Executing", parent_id: local.id, project_id: "example",
      work: { title: "Run local work" }, dependencies: [], attempts: [], owning_node: "Studio" });
    Object.assign(data.items[remote.id], { state: "Ready", project_id: "kmac", job_ids: [`${remote.id}-1`] });
    data.jobs[`${remote.id}-1`] = record(`${remote.id}-1`, { state: "Verification", parent_id: remote.id, project_id: "kmac",
      work: { title: "Update Kmac" }, dependencies: [], project_context: { runtime: "herdr" }, attempts: [{ execution: { remote_execution: {
        runtime: "herdr", machine_selector: "iMac", agent_target: "roundhouse-imac", workspace_mode: "machine_local",
        working_directory: "/home/ryngrn/kmac", execution_id: "remote-run-42",
      } } }] });
  });
  const script = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  const projected = statusView(h.store.read());
  projected.untracked_activity = [
    { kind: "process", status: "untracked", authoritative: false, pid: 909, parent_pid: 1, executable: "codex", observed_at: "2026-10-05T00:00:00.000Z" },
    { kind: "worktree", status: "untracked", authoritative: false, repository: "/repo", path: "/tmp/manual-agent", branch: "manual-agent", commit: "abc", observed_at: "2026-10-05T00:00:00.000Z" },
  ];
  const responses = {
    "/api/overview": { ...projected, counts: { needs_you: 0, active: 2, queued: 0, completed: 0, blocked: 0 },
      connection: { worker: { running: false }, storage: { kind: "local", node: null } } },
    "/api/config": { configuration: { projects: [{ id: "example", name: "Example" }, { id: "kmac", name: "Kmac" }] } },
  };
  const document = browserDocument();
  const browserFetch = async (pathname) => {
    const body = responses[pathname];
    return { ok: Boolean(body), status: body ? 200 : 404, text: async () => JSON.stringify(body || { error: "Not found" }) };
  };
  vm.runInNewContext(script, { document, fetch: browserFetch, crypto: {}, setTimeout: () => 1 }, { filename: "served-app.js" });
  await settleUntil(() => document.querySelector("#active-jobs").children.length === 2);

  assert.equal(document.querySelector("#active-jobs-section").hidden, false);
  const rendered = elementText(document.querySelector("#active-jobs"));
  assert.match(rendered, /Chugging along…\s+example · Run local work\s+Local execution on Studio/);
  assert.match(rendered, /Chugging along…\s+kmac · Update Kmac\s+Machine-local execution on iMac/);
  assert.match(rendered, /Agent · roundhouse-imac\s+Directory · \/home\/ryngrn\/kmac\s+Remote run · remote-run-42/);
  assert.doesNotMatch(rendered, /Herdr queue/i);
  const untracked = elementText(document.querySelector("#untracked-activity"));
  assert.equal(document.querySelector("#untracked-activity-section").hidden, false);
  assert.match(untracked, /Untracked\s+Possible executor process · PID 909\s+Executable · codex/);
  assert.match(untracked, /Repository worktree · manual-agent\s+\/tmp\/manual-agent/);
  assert.match(untracked, /Observed only · no job, owner, completion, or delivery inferred/);
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
