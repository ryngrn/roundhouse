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
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.value = "";
    this.textContent = "";
    this.className = "";
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() {}
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
    createElement() { return new BrowserElement(); },
  };
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

test("served browser client submits Depot work without crypto.randomUUID", async (t) => {
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
  content.value = "ship from a browser without secure-context crypto";
  hint.value = "example";
  await form.listeners.get("submit")({ preventDefault() {} });

  const [item] = Object.values(h.store.read().items);
  assert.equal(item.input.project_hint, "example");
  assert.match(message.textContent, new RegExp(`^Saved ${item.id}\\. The local worker will pick it up\\.$`));
  assert.equal(content.value, "");
  assert.equal(hint.value, "");

  await form.listeners.get("submit")({ preventDefault() {} });
  assert.equal(message.textContent, "Intake requires nonempty content.");
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
