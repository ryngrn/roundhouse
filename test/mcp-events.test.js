import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { harness } from "./support/harness.js";
import { Store } from "../src/workflow/store.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { MCP_PROTOCOL_VERSION, McpEventBroker, WORK_EVENT_NAME } from "../src/mcp/events.js";
import { startMcpHttpServer } from "../src/mcp/http-server.js";

const envelope = {
  "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "roundhouse-events-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function rpc(url, id, method, params = {}, meta = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: { ...envelope, ...meta } } }),
  });
  const body = await response.json();
  assert.equal(response.headers.get("mcp-protocol-version"), MCP_PROTOCOL_VERSION);
  return body;
}

test("MCP Events: supported ChatGPT submission establishes an item follow without a status read", async (t) => {
  const h = harness();
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const receiver = await callbackReceiver(secret);
  t.after(receiver.close);
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  let running = await startMcpHttpServer({
    service,
    eventBroker: new McpEventBroker({ service, allowInsecureLoopback: true, timeoutMs: 2_000 }),
    port: 0,
  });
  t.after(async () => { if (running) await running.close(); });
  const conversationMeta = { "openai/session": "chatgpt-conversation-private-value" };

  const added = await rpc(running.url, 1, "tools/call", {
    name: "add_to_depot",
    arguments: { content: "follow this submission", idempotency_key: "originating-follow" },
  }, conversationMeta);
  const itemId = added.result.structuredContent.item.id;
  assert.equal(added.result.structuredContent.item.state, "Depot");
  assert.deepEqual(added.result.structuredContent.follow, {
    event: WORK_EVENT_NAME,
    arguments: { item_id: itemId, include_progress: false },
  });

  const subscribed = await rpc(running.url, 2, "events/subscribe", {
    name: added.result.structuredContent.follow.event,
    arguments: added.result.structuredContent.follow.arguments,
    delivery: { mode: "webhook", url: receiver.url, secret },
    cursor: null,
  }, conversationMeta);
  assert.match(subscribed.result.id, /^sub_[a-f0-9]{32}$/);

  const snapshot = new Store(h.store.directory).read();
  const stored = snapshot.mcp_events.subscriptions[subscribed.result.id];
  assert.deepEqual(stored.arguments, { item_id: itemId, include_progress: false });
  assert.equal(stored.conversation.source, "chatgpt");
  assert.equal(stored.conversation.relationship, "originating_submission");
  assert.match(stored.conversation.id, /^conversation_[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(snapshot).includes("chatgpt-conversation-private-value"), false);
  assert.deepEqual(snapshot.mcp_events.conversations[stored.conversation.id].item_ids, [itemId]);

  const otherConversation = { "openai/session": "different-chatgpt-conversation" };
  const otherThread = await rpc(running.url, "other-thread", "events/subscribe", {
    name: WORK_EVENT_NAME,
    arguments: { item_id: itemId, include_progress: false },
    delivery: { mode: "webhook", url: receiver.url, secret },
    cursor: null,
  }, otherConversation);
  assert.notEqual(otherThread.result.id, subscribed.result.id);
  const isolated = new Store(h.store.directory).read().mcp_events.subscriptions;
  assert.equal(isolated[subscribed.result.id].conversation.id, stored.conversation.id);
  assert.notEqual(isolated[otherThread.result.id].conversation.id, stored.conversation.id);

  const existingItem = service.addToDepot({ content: "follow existing work", idempotency_key: "later-follow" }).item;
  const followed = await rpc(running.url, 3, "events/subscribe", {
    name: WORK_EVENT_NAME,
    arguments: { item_id: existingItem.id },
    delivery: { mode: "webhook", url: receiver.url, secret },
    cursor: null,
  }, conversationMeta);
  const followedState = new Store(h.store.directory).read().mcp_events.subscriptions[followed.result.id];
  assert.equal(followedState.conversation.id, stored.conversation.id);
  assert.equal(followedState.conversation.relationship, "follow");

  await running.close();
  running = null;
  const restartedService = new RoundhouseService({ store: new Store(h.store.directory), engine: h.engine });
  const restarted = new McpEventBroker({ service: restartedService, allowInsecureLoopback: true, timeoutMs: 2_000 });
  running = await startMcpHttpServer({ service: restartedService, eventBroker: restarted, port: 0 });
  const persisted = new Store(h.store.directory).read().mcp_events.subscriptions[subscribed.result.id];
  assert.equal(persisted.active, true);
  assert.equal(persisted.conversation.id, stored.conversation.id);
});

async function callbackReceiver(secret, { failFirstDelivery = false } = {}) {
  const received = [];
  const attempts = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(" ") : value ?? ""]));
    const parsed = new Webhook(secret).verify(body, headers);
    if (parsed.type === "verification") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: parsed.challenge }));
      return;
    }
    attempts.push({ body: parsed, headers });
    if (failFirstDelivery && attempts.length === 1) {
      response.writeHead(503).end();
      return;
    }
    received.push({ body: parsed, headers });
    response.writeHead(204).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    received, attempts,
    url: `http://127.0.0.1:${address.port}/callback`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("MCP Events: discover, list, durable subscription, signed delivery, dedupe, and unsubscribe", async (t) => {
  const h = harness();
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const receiver = await callbackReceiver(secret, { failFirstDelivery: true });
  t.after(receiver.close);
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const item = service.addToDepot({ content: "ambiguous event callback", idempotency_key: "events-item" }).item;
  await assert.rejects(
    new McpEventBroker({ service }).subscribe({
      name: WORK_EVENT_NAME,
      arguments: { item_id: item.id },
      delivery: { mode: "webhook", url: receiver.url.replace("http:", "https:"), secret },
    }),
    (error) => error.data?.reason === "callback_address_not_public",
  );
  let broker = new McpEventBroker({ service, allowInsecureLoopback: true, retryDelaysMs: [0], timeoutMs: 2_000 });
  let running = await startMcpHttpServer({ service, eventBroker: broker, port: 0 });
  t.after(async () => { if (running) await running.close(); });

  const discovered = await rpc(running.url, 1, "server/discover");
  assert.deepEqual(discovered.result.supportedVersions, [MCP_PROTOCOL_VERSION]);
  assert.deepEqual(discovered.result.capabilities, { tools: {}, events: {} });
  assert.equal(discovered.result.resultType, "complete");
  assert.equal(discovered.result._meta["io.modelcontextprotocol/serverInfo"].name, "roundhouse-depot");

  const tools = await rpc(running.url, "tools", "tools/list");
  assert.deepEqual(tools.result.tools.map((tool) => tool.name).sort(), ["add_to_depot", "answer_question", "get_needs_human", "get_work_status"]);
  assert.equal(tools.result.tools.find((tool) => tool.name === "add_to_depot").inputSchema.additionalProperties, false);

  const listed = await rpc(running.url, 2, "events/list");
  assert.deepEqual(listed.result.events.map((event) => event.name), [WORK_EVENT_NAME]);
  assert.deepEqual(listed.result.events[0].delivery, ["webhook"]);

  const subscriptionParams = {
    name: WORK_EVENT_NAME,
    arguments: { item_id: item.id },
    delivery: { mode: "webhook", url: receiver.url, secret },
    cursor: null,
  };
  const subscribed = await rpc(running.url, 3, "events/subscribe", subscriptionParams);
  assert.match(subscribed.result.id, /^sub_[a-f0-9]{32}$/);
  assert.equal(subscribed.result.cursor, null);
  assert.equal(subscribed.result.truncated, false);
  const stored = new Store(h.store.directory).read().mcp_events.subscriptions[subscribed.result.id];
  assert.equal(stored.active, true);
  assert.equal(stored.delivery.url, receiver.url);

  await running.close();
  running = null;
  const restartedService = new RoundhouseService({ store: new Store(h.store.directory), engine: h.engine });
  broker = new McpEventBroker({ service: restartedService, allowInsecureLoopback: true, retryDelaysMs: [0], timeoutMs: 2_000 });
  running = await startMcpHttpServer({ service: restartedService, eventBroker: broker, port: 0 });
  assert.equal(new Store(h.store.directory).read().mcp_events.subscriptions[subscribed.result.id].active, true);

  await h.engine.decide(item.id);
  await broker.drain();
  await broker.drain();
  assert.equal(receiver.received.length, 1);
  assert.equal(receiver.attempts.length, 2);
  assert.equal(new Set(receiver.attempts.map((attempt) => attempt.body.eventId)).size, 1);
  const delivered = receiver.received[0];
  assert.equal(delivered.body.name, WORK_EVENT_NAME);
  assert.equal(delivered.body.data.item_id, item.id);
  assert.equal(delivered.body.data.state, "Needs Clarification");
  assert.equal(delivered.body.data.kind, "needs_you");
  assert.ok(delivered.body.data.question_id);
  assert.equal(delivered.body.data.question_revision, 1);
  assert.equal(delivered.headers["webhook-id"], delivered.body.eventId);
  assert.equal(delivered.headers["x-mcp-subscription-id"], subscribed.result.id);
  const deliveries = Object.values(new Store(h.store.directory).read().mcp_events.deliveries);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "delivered");
  assert.equal(deliveries[0].attempts, 2);

  await h.store.change((data) => h.store.move(data, data.items[item.id], "Blocked", "A material dependency needs operator attention."));
  await broker.drain();
  assert.equal(receiver.received.length, 2);
  assert.equal(receiver.received[1].body.data.kind, "blocked");
  assert.equal(receiver.received[1].body.data.state, "Blocked");

  await running.close();
  running = null;
  const secondRestartService = new RoundhouseService({ store: new Store(h.store.directory), engine: h.engine });
  broker = new McpEventBroker({ service: secondRestartService, allowInsecureLoopback: true, retryDelaysMs: [0], timeoutMs: 2_000 });
  running = await startMcpHttpServer({ service: secondRestartService, eventBroker: broker, port: 0 });
  await broker.drain();
  assert.equal(receiver.received.length, 2);

  const unsubscribed = await rpc(running.url, 4, "events/unsubscribe", {
    name: WORK_EVENT_NAME,
    arguments: { item_id: item.id },
    delivery: { mode: "webhook", url: receiver.url },
  });
  assert.equal(unsubscribed.result.resultType, "complete");
  assert.equal(new Store(h.store.directory).read().mcp_events.subscriptions[subscribed.result.id].active, false);
});

test("MCP Events: progress is opt-in and unrelated terminal outcomes remain silent", async (t) => {
  const h = harness();
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const receiver = await callbackReceiver(secret);
  t.after(receiver.close);
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const item = service.addToDepot({ content: "filter callback policy", project_hint: "example", idempotency_key: "events-filter" }).item;
  const broker = new McpEventBroker({ service, allowInsecureLoopback: true, timeoutMs: 2_000 });
  await broker.subscribe({
    name: WORK_EVENT_NAME,
    arguments: { item_id: item.id },
    delivery: { mode: "webhook", url: receiver.url, secret },
    cursor: null,
  });

  await h.store.change((data) => {
    for (const state of ["Executing", "Verification", "Archived", "Reconciled"]) {
      data.outbox.push({ id: `default-${state}`, entity_id: item.id, item_id: item.id, state, reason: "policy fixture", at: new Date().toISOString() });
    }
  });
  await broker.drain();
  assert.equal(receiver.received.length, 0);

  await broker.subscribe({
    name: WORK_EVENT_NAME,
    arguments: { item_id: item.id, include_progress: true },
    delivery: { mode: "webhook", url: receiver.url, secret },
    cursor: null,
  });
  await h.store.change((data) => {
    for (const state of ["Executing", "Verification", "Archived"]) {
      data.outbox.push({ id: `opt-in-${state}`, entity_id: item.id, item_id: item.id, state, reason: "policy fixture", at: new Date().toISOString() });
    }
  });
  await broker.drain();
  assert.deepEqual(receiver.received.map((entry) => entry.body.data.state), ["Executing", "Verification"]);
  assert.ok(receiver.received.every((entry) => entry.body.data.kind === "progress"));
});

test("MCP Events: a multi-job item emits one concise Shipped outcome", async (t) => {
  const h = harness();
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const receiver = await callbackReceiver(secret);
  t.after(receiver.close);
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const item = service.addToDepot({ content: "decompose this shipment", project_hint: "example", idempotency_key: "multi-ship" }).item;
  const broker = new McpEventBroker({ service, allowInsecureLoopback: true, timeoutMs: 2_000 });
  await broker.subscribe({
    name: WORK_EVENT_NAME,
    arguments: { project_id: "example" },
    delivery: { mode: "webhook", url: receiver.url, secret },
    cursor: null,
  });

  await h.engine.run();
  await broker.drain();
  assert.equal(receiver.received.length, 1);
  const event = receiver.received[0].body;
  assert.equal(event.data.kind, "shipped");
  assert.equal(event.data.state, "Shipped");
  assert.equal(event.data.shipping.deliveries.length, 2);
  assert.deepEqual(Object.keys(event.data.shipping), ["deliveries"]);
});
