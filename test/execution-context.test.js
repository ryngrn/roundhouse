import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executionPacket, formatExecutionBrief, jobWithCurrentRequestContext, requestContextFromItem } from "../src/workflow/execution-context.js";
import { LocalRuntime } from "../src/workflow/runtime.js";
import { harness } from "./support/harness.js";

const originalRequest = `# Build the monitor\n\n## Requirements\n- Preserve the exact hierarchy.\n- Verify the working result.`;
const conversation = {
  link: "chatgpt://conversation/roundhouse-context",
  snapshot: { captured_at: "2026-10-08T01:00:00Z", messages: [
    { role: "user", text: "The original hierarchy is important." },
    { role: "assistant", text: "I will preserve it." },
  ] },
  live_context: { updated_at: "2026-10-08T02:00:00Z", messages: [
    { role: "user", text: "Use the existing colors, not a new palette." },
  ] },
};

test("execution request context preserves the verbatim structured request, transcript, live context, and later answers", () => {
  const item = { input: { text: originalRequest, context: { surface: "iPad monitor" }, conversation }, clarifications: [
    { text: "Keep the compact layout.", actor: "ryan", at: "2026-10-08T03:00:00Z", question_id: "q-1" },
  ] };
  const context = requestContextFromItem(item);
  assert.equal(context.original_request, originalRequest);
  assert.deepEqual(context.conversation, conversation);
  assert.deepEqual(context.supplied_context, { surface: "iPad monitor" });
  assert.deepEqual(context.operator_clarifications, [{ text: "Keep the compact layout.", actor: "ryan",
    at: "2026-10-08T03:00:00Z", question_id: "q-1" }]);
  item.input.conversation.snapshot.messages[0].text = "mutated after capture";
  assert.equal(context.conversation.snapshot.messages[0].text, "The original hierarchy is important.");
});

test("human-readable execution brief leads with original intent before transcript and generated slice", () => {
  const packet = executionPacket({
    request_context: requestContextFromItem({ input: { text: originalRequest, conversation }, clarifications: [] }),
    work: { title: "Generated slice", outcome: "A normalized paraphrase", acceptance_criteria: [] },
    project_context: { id: "monitor", agent_profile: { private: "omitted" } },
  });
  const brief = formatExecutionBrief(packet);
  assert.ok(brief.indexOf(originalRequest) < brief.indexOf("Conversation transcript"));
  assert.ok(brief.indexOf("Conversation transcript") < brief.indexOf("Generated slice"));
  assert.match(brief, /original request as the primary statement of intent/i);
  assert.match(brief, /later explicit user corrections supersede earlier conflicting statements/i);
  assert.doesNotMatch(brief, /"private":"omitted"/);
});

test("already-queued jobs receive the latest parent transcript at execution time", () => {
  const job = { id: "queued-job", parent_id: "parent", work: { title: "Old generated slice" },
    request_context: { original_request: "stale request" } };
  const enriched = jobWithCurrentRequestContext({ items: { parent: {
    input: { text: originalRequest, conversation },
    clarifications: [{ text: "Newest answer wins.", actor: "ryan", at: "2026-10-08T04:00:00Z" }],
  } } }, job);
  assert.equal(enriched.request_context.original_request, originalRequest);
  assert.equal(enriched.request_context.conversation.live_context.messages[0].text, "Use the existing colors, not a new palette.");
  assert.equal(enriched.request_context.operator_clarifications[0].text, "Newest answer wins.");
});

test("new jobs retain source context and command executors receive it ahead of the generated work slice", async () => {
  const h = harness();
  const item = h.store.submit({ text: originalRequest, project_id: "example", source: "chatgpt", actor: "ryan",
    context: { surface: "iPad monitor" }, conversation }, "rich-execution-context");
  await h.engine.runTriage();
  const state = h.store.read();
  const job = state.jobs[state.items[item.id].job_ids[0]];
  assert.equal(job.request_context.original_request, originalRequest);
  assert.deepEqual(job.request_context.conversation, conversation);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-execution-context-"));
  const capture = path.join(root, "packet.json");
  const executor = path.join(root, "capture.mjs");
  fs.writeFileSync(executor, `import fs from "node:fs"; let input=""; process.stdin.on("data",d=>input+=d); process.stdin.on("end",()=>{ fs.writeFileSync(${JSON.stringify(capture)}, input); console.log(JSON.stringify({summary:"captured"})); });`);
  const result = await new LocalRuntime().execute({
    project: { repository: null, timeout_ms: 10_000, executor: { kind: "command", command: [process.execPath, executor] } },
    job, workspace: root, directory: root, previous_failure: null, run: { id: "run-1" }, onStart: () => {},
  });
  assert.equal(result.passed, true);
  const received = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(received.request_context.original_request, originalRequest);
  assert.deepEqual(received.request_context.conversation, conversation);
  assert.equal(received.work.title, job.work.title);
  assert.deepEqual(Object.keys(received).slice(0, 2), ["request_context", "work"]);
});
