import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./support/harness.js";
import { RoundhouseService, normalizeIntake } from "../src/workflow/service.js";
import { WorkerLoop } from "../src/server/worker.js";

function blockStandalone(h, text) {
  const item = h.submit(text, text);
  h.store.change((data) => h.store.move(data, data.items[item.id], "Blocked", "Fixture needs cleanup."));
  return item.id;
}

test("cleanup agent permanently deletes low-value blocked work and keeps a concise tombstone", async () => {
  const h = harness();
  const id = blockStandalone(h, "cleanup delete obsolete experiment");
  const result = await h.engine.runUnblocker();
  assert.equal(result.cleanup.action, "delete");
  const state = h.store.read();
  assert.equal(state.items[id], undefined);
  const tombstone = state.system_metadata.cleanup_tombstones.at(-1);
  assert.deepEqual({ id: tombstone.id, kind: tombstone.kind, confidence: tombstone.confidence }, { id, kind: "item", confidence: 0.91 });
  assert.match(tombstone.reason, /obsolete/);
  assert.equal(tombstone.original_request, undefined);
});

test("deleting a blocked prerequisite preserves dependent identity and records crossed-out scope", async () => {
  const h = harness();
  const first = h.submit("cleanup delete obsolete prerequisite", "cleanup-prerequisite");
  const second = h.submit("still useful dependent", "cleanup-dependent");
  await h.engine.runTriage();
  await h.engine.runTriage();
  const snapshot = h.store.read();
  const blockedId = snapshot.items[first.id].job_ids[0];
  const dependentId = snapshot.items[second.id].job_ids[0];
  h.store.change((data) => {
    data.jobs[dependentId].dependencies = [blockedId];
    h.store.move(data, data.jobs[blockedId], "Blocked", "Fixture needs cleanup.");
    data.projects.example = { ...(data.projects.example ?? {}), blocked: true };
  });
  const result = await h.engine.runUnblocker();
  assert.equal(result.cleanup.action, "delete");
  const state = h.store.read();
  assert.equal(state.jobs[blockedId], undefined);
  assert.ok(state.jobs[dependentId]);
  assert.deepEqual(state.jobs[dependentId].dependencies, []);
  assert.equal(state.jobs[dependentId].scope_revision.source, "roundhouse-unblocker");
  assert.match(state.jobs[dependentId].scope_revision.removed_scope[0], new RegExp(blockedId));
});

test("below 70 percent cleanup asks two contextual choices plus a free-form third path", async () => {
  const h = harness();
  const id = blockStandalone(h, "cleanup ask ambiguous old idea");
  const result = await h.engine.runUnblocker();
  assert.equal(result.cleanup.action, "ask");
  const issue = h.store.read().items[id].issue_resolution;
  assert.equal(issue.confidence, 0.55);
  assert.equal(issue.options.length, 3);
  assert.equal(issue.options[2], "Take my own path");
  assert.match(issue.question, /preserve|delete/i);
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const answer = service.resolveIssue({ issue_id: id, expected_revision: h.store.read().items[id].revision,
    action: "custom", message: "Keep only the reporting outcome.", actor: "ryan" });
  assert.equal(answer.recorded, true);
  assert.equal(h.store.read().items[id].issue_resolution.response.message, "Keep only the reporting outcome.");
});

test("intake preserves an immutable transcript snapshot and live conversation context", () => {
  const conversation = { link: "chatgpt://conversation/example", snapshot: { captured_at: "2026-10-08T00:00:00Z",
    messages: [{ role: "user", text: "Make sense of this request." }] }, live_context: { updated_at: "2026-10-08T01:00:00Z", messages: [] } };
  const normalized = normalizeIntake({ content: "Use the conversation", conversation }, { source: "chatgpt", actor: "ryan" });
  assert.deepEqual(normalized.conversation, conversation);
  conversation.snapshot.messages[0].text = "mutated";
  assert.equal(normalized.conversation.snapshot.messages[0].text, "Make sense of this request.");
});

test("worker accepts hosted issue_resolution commands", async () => {
  const calls = [];
  const commands = [{ id: "resolution-1", kind: "issue_resolution", payload: { issue_id: "blocked-1", expected_revision: 2,
    action: "custom", message: "Take a smaller path." } }];
  const queue = { claimRemoteCommand: async () => commands.shift() ?? null,
    finishRemoteCommand: async (id, result) => calls.push({ id, result }) };
  const service = { resolveIssue: (input) => { calls.push(input); return { recorded: true }; } };
  const worker = new WorkerLoop({ service, commandQueue: queue });
  const result = await worker.remoteCommandTick();
  assert.equal(result.remote_commands, 1);
  assert.equal(calls[0].issue_id, "blocked-1");
  assert.equal(calls[0].actor, "ryan");
});

test("cleanup never evaluates work outside Blocked or Needs Clarification", async () => {
  const h = harness();
  const item = h.submit("cleanup delete ready work must remain", "cleanup-boundary");
  await h.engine.runTriage();
  const before = h.store.read();
  const jobId = before.items[item.id].job_ids[0];
  assert.equal(before.jobs[jobId].state, "Ready");
  const result = await h.engine.runUnblocker();
  assert.equal(result.cleanup, null);
  const after = h.store.read();
  assert.ok(after.items[item.id]);
  assert.equal(after.jobs[jobId].state, "Ready");
});
