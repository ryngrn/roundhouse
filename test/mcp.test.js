import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { harness } from "./support/harness.js";
import { Store } from "../src/workflow/store.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { startMcpHttpServer } from "../src/mcp/http-server.js";
import { CHATGPT_INTEGRATION_INSTRUCTIONS, callRoundhouseTool, roundhouseToolCatalog } from "../src/mcp/server.js";

async function connected(h) {
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const running = await startMcpHttpServer({ service, port: 0 });
  const client = new Client({ name: "roundhouse-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
  return { client, running };
}

const statusWithHost = (url, host) => new Promise((resolve, reject) => {
  const request = get(url, { headers: { host } }, (response) => {
    response.resume();
    response.on("end", () => resolve(response.statusCode));
  });
  request.on("error", reject);
});

test("integration: MCP transport provides polling fallback when Events are unavailable", async (t) => {
  const h = harness();
  const { client, running } = await connected(h);
  t.after(async () => { await client.close(); await running.close(); });
  assert.equal(await statusWithHost(running.url, "attacker.invalid"), 403);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["add_to_depot", "answer_question", "get_needs_human", "get_work_status"]);
  assert.equal(listed.tools.find((tool) => tool.name === "get_work_status").annotations.readOnlyHint, true);
  assert.equal(listed.tools.find((tool) => tool.name === "add_to_depot").annotations.readOnlyHint, false);

  const invalid = await client.callTool({ name: "add_to_depot", arguments: { content: "" } });
  assert.equal(invalid.isError, true);
  assert.equal((await client.callTool({ name: "get_needs_human", arguments: { item_id: "" } })).isError, true);
  assert.equal((await client.callTool({ name: "get_work_status", arguments: { project_id: "" } })).isError, true);
  assert.equal((await client.callTool({ name: "answer_question", arguments: { id: "missing", answer: "answer", expected_revision: 0 } })).isError, true);

  const added = await client.callTool({ name: "add_to_depot", arguments: {
    content: "  ambiguous MCP idea\n",
    project_hint: "Maybe Example",
    context: { conversation: "Keep the original discussion attached." },
    attachments: [{ uri: "https://example.invalid/context.txt", name: "context.txt", media_type: "text/plain" }],
    metadata: { conversation_id: "chat-123" },
    idempotency_key: "chat-123-turn-4",
  } });
  assert.equal(added.isError, undefined);
  assert.equal(added.structuredContent.item.state, "Depot");
  const itemId = added.structuredContent.item.id;
  assert.deepEqual(added.structuredContent.follow, {
    event: "roundhouse.work.updated",
    arguments: { item_id: itemId, include_progress: false },
  });
  const restarted = new Store(h.store.directory).read().items[itemId];
  assert.equal(restarted.input.text, "  ambiguous MCP idea\n");
  assert.equal(restarted.input.project_hint, "Maybe Example");
  assert.deepEqual(restarted.input.context, { conversation: "Keep the original discussion attached." });
  assert.equal(restarted.input.attachments[0].uri, "https://example.invalid/context.txt");
  assert.equal(restarted.input.project_id, undefined);

  const duplicate = await client.callTool({ name: "add_to_depot", arguments: {
    content: "  ambiguous MCP idea\n", project_hint: "Maybe Example", context: { conversation: "Keep the original discussion attached." },
    attachments: [{ uri: "https://example.invalid/context.txt", name: "context.txt", media_type: "text/plain" }],
    metadata: { conversation_id: "chat-123" }, idempotency_key: "chat-123-turn-4",
  } });
  assert.equal(duplicate.structuredContent.item.id, itemId);

  await h.engine.run();
  const pending = await client.callTool({ name: "get_needs_human", arguments: { item_id: itemId } });
  assert.equal(pending.structuredContent.questions.length, 1);
  const question = pending.structuredContent.questions[0];
  assert.equal(question.revision, 1);

  const answered = await client.callTool({ name: "answer_question", arguments: {
    id: question.decision_id, answer: "Use Example and append a feature entry.", expected_revision: question.revision,
  } });
  assert.equal(answered.structuredContent.answer_recorded, true);
  assert.equal(answered.structuredContent.reevaluated, true);
  assert.equal(answered.structuredContent.item.state, "Ready");
  assert.equal(new Store(h.store.directory).read().items[itemId].questions[0].status, "answered");
  assert.equal(new RoundhouseService({ stateDirectory: h.store.directory }).getWorkStatus({ item_id: itemId }).items[0].state, "Ready");

  const stale = await client.callTool({ name: "answer_question", arguments: {
    id: question.id, answer: "Duplicate answer", expected_revision: question.revision,
  } });
  assert.equal(stale.isError, true);

  const status = await client.callTool({ name: "get_work_status", arguments: { item_id: itemId } });
  assert.equal(status.structuredContent.items[0].state, "Ready");
  assert.equal(status.structuredContent.items[0].project, "example");
  assert.equal((await client.callTool({ name: "get_needs_human", arguments: { item_id: itemId } })).structuredContent.questions.length, 0);
});

test("service: intake validation and idempotency conflicts stay in the normalized adapter boundary", () => {
  const h = harness();
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const statusTool = roundhouseToolCatalog.find((tool) => tool.name === "get_work_status");
  assert.ok(statusTool.outputSchema.properties.allocations);
  const jobProperties = statusTool.outputSchema.properties.items.items.properties.jobs.items.properties;
  assert.ok(jobProperties.action_policy);
  assert.ok(jobProperties.human_task);
  assert.throws(() => service.addToDepot({ content: "" }), /nonempty/);
  assert.throws(() => service.addToDepot({ content: "idea", attachments: Array(21).fill({}) }), /at most 20/);
  service.addToDepot({ content: "first", idempotency_key: "same" });
  assert.throws(() => service.addToDepot({ content: "changed", idempotency_key: "same" }), /different content/);
  assert.throws(() => service.getWorkStatus({ unknown: "filter" }), /Unknown filter/);
});

test("Claude conversation intake, clarification, and status retain durable origin contracts", async () => {
  const h = harness();
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const origin = {
    source: "claude", actor: "claude-user-7", project_id: "example",
    thread_id: "thread-42", correlation_id: "turn-9",
  };
  const request = { content: "ambiguous Claude idea", origin, metadata: { transport: "remote-mcp" } };
  const submitted = await callRoundhouseTool(service, "add_to_depot", request);
  const duplicate = await callRoundhouseTool(service, "add_to_depot", request);
  assert.equal(duplicate.structuredContent.item.id, submitted.structuredContent.item.id);
  const itemId = submitted.structuredContent.item.id;
  let stored = h.store.read().items[itemId];
  assert.deepEqual({
    source: stored.input.source, actor: stored.input.actor, project_id: stored.input.project_id,
    thread_id: stored.input.thread_id, correlation_id: stored.input.correlation_id,
  }, origin);
  assert.deepEqual(stored.input.metadata, { transport: "remote-mcp" });
  await assert.rejects(() => callRoundhouseTool(service, "add_to_depot", { content: "changed", origin }), /different content/);

  await h.engine.run();
  const pending = await callRoundhouseTool(service, "get_needs_human", {
    source: "claude", thread_id: origin.thread_id, correlation_id: origin.correlation_id,
  });
  assert.equal(pending.structuredContent.questions.length, 1);
  const question = pending.structuredContent.questions[0];
  await assert.rejects(() => callRoundhouseTool(service, "answer_question", {
    id: question.id, answer: "wrong thread", expected_revision: question.revision,
    origin: { ...origin, thread_id: "other-thread" },
  }), /originating Claude conversation/);
  const answered = await callRoundhouseTool(service, "answer_question", {
    id: question.id, answer: "Use Example and append a feature entry.", expected_revision: question.revision, origin,
  });
  assert.equal(answered.structuredContent.item.state, "Ready");
  stored = h.store.read().items[itemId];
  assert.equal(stored.questions[0].answer.source, "claude");
  assert.equal(stored.questions[0].answer.thread_id, origin.thread_id);
  assert.equal(stored.clarifications[0].correlation_id, origin.correlation_id);

  const before = JSON.stringify(h.store.read());
  const status = await callRoundhouseTool(service, "get_work_status", {
    source: "claude", thread_id: origin.thread_id, correlation_id: origin.correlation_id,
  });
  assert.equal(status.structuredContent.items[0].id, itemId);
  assert.equal(JSON.stringify(h.store.read()), before);
  await assert.rejects(() => callRoundhouseTool(service, "get_work_status", {
    source: "claude", thread_id: origin.thread_id, policy: { shipping: "deploy" },
  }), /Unrecognized key/);
});

test("ChatGPT implementation intake persists before Roundhouse triage and claimed dispatch select an internal executor", async () => {
  const h = harness();
  let runtimeCalls = 0;
  const internalRuntime = h.engine.runtime;
  h.engine.runtime = {
    execute: async (request) => {
      runtimeCalls += 1;
      return internalRuntime.execute(request);
    },
  };
  const service = new RoundhouseService({ store: h.store, engine: h.engine });

  const submitted = await callRoundhouseTool(service, "add_to_depot", {
    content: "Implement the supported ChatGPT change",
    idempotency_key: "chatgpt-implementation-ownership",
  });
  const itemId = submitted.structuredContent.item.id;
  let state = h.store.read();
  assert.equal(submitted.structuredContent.durable, true);
  assert.equal(state.items[itemId].state, "Depot");
  assert.equal(state.items[itemId].input.source, "chatgpt:mcp");
  assert.deepEqual(state.items[itemId].job_ids, []);
  assert.equal(runtimeCalls, 0);

  await h.engine.runTriage();
  state = h.store.read();
  assert.equal(state.items[itemId].state, "Ready");
  assert.equal(state.items[itemId].job_ids.length, 1);
  assert.equal(state.jobs[state.items[itemId].job_ids[0]].state, "Ready");
  assert.equal(runtimeCalls, 0);

  const dispatched = await h.engine.runDispatch();
  state = h.store.read();
  assert.equal(dispatched.executed, 1);
  assert.equal(runtimeCalls, 1);
  assert.equal(state.jobs[state.items[itemId].job_ids[0]].state, "Shipped");
  assert.equal(state.jobs[state.items[itemId].job_ids[0]].attempts[0].run.provider_id, "local-project");
});

test("ChatGPT capability catalog exposes Depot ownership without a direct implementation runtime", () => {
  assert.deepEqual(roundhouseToolCatalog.map((tool) => tool.name).sort(), [
    "add_to_depot", "answer_question", "get_needs_human", "get_work_status",
  ]);
  const intake = roundhouseToolCatalog.find((tool) => tool.name === "add_to_depot");
  assert.match(intake.description, /only supported intake for ChatGPT implementation requests/i);
  assert.match(intake.description, /does not execute work or select an executor/i);
  assert.match(CHATGPT_INTEGRATION_INSTRUCTIONS, /never invoke or present a direct implementation runtime/i);
  assert.match(CHATGPT_INTEGRATION_INSTRUCTIONS, /executor selection, job claims/i);
  assert.match(CHATGPT_INTEGRATION_INSTRUCTIONS, /before any executor or Herdr dispatch/i);
  assert.match(CHATGPT_INTEGRATION_INSTRUCTIONS, /Remote Desktop Commander is not a project execution runtime/i);
  assert.match(CHATGPT_INTEGRATION_INSTRUCTIONS, /transport, inspection, connectivity checks, bootstrap, and emergency repair/i);
  assert.equal(roundhouseToolCatalog.some((tool) => /(?:execute|codex|herdr|implement)/i.test(tool.name)), false);
});
