import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeExecutorArgs, claudeResult, claudeDefaultTools } from "../src/workflow/runtime.js";
import { claudeDecisionArgs, decisionSchema } from "../src/workflow/decision.js";
import { loadWorkflowConfig } from "../src/workflow/config.js";

test("claude executor runs headless with auto-accepted edits and an explicit tool allowlist", () => {
  const args = claudeExecutorArgs({ kind: "claude" });
  assert.deepEqual(args, ["claude", "-p", "--output-format", "json", "--no-session-persistence",
    "--permission-mode", "acceptEdits", "--allowedTools", claudeDefaultTools.join(",")]);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(args.includes("bypassPermissions"), false);
  const custom = claudeExecutorArgs({ kind: "claude", bin: "/opt/claude", allowed_tools: ["Read", "Edit", "Bash(npm test:*)"] });
  assert.equal(custom[0], "/opt/claude");
  assert.equal(custom.at(-1), "Read,Edit,Bash(npm test:*)");
});

test("claude decision provider has no tools and is constrained to the decision schema", () => {
  const args = claudeDecisionArgs({ kind: "claude" });
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.deepEqual(JSON.parse(args[args.indexOf("--json-schema") + 1]), decisionSchema);
});

test("claude result envelope keeps the summary and structured output, and treats garbage as an error", () => {
  assert.deepEqual(claudeResult(JSON.stringify({ type: "result", is_error: false, result: "Done.", structured_output: { ok: true } })),
    { is_error: false, summary: "Done.", structured_output: { ok: true } });
  assert.equal(claudeResult(JSON.stringify({ is_error: true, result: "Ran out of turns" })).is_error, true);
  assert.equal(claudeResult("not json").is_error, true);
});

test("configuration accepts claude for decisions and execution and validates allowed_tools", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-claude-config-"));
  const write = (executor) => {
    const file = path.join(root, "config.json");
    fs.writeFileSync(file, JSON.stringify({ decision: { kind: "claude" }, projects: [{ id: "example", name: "Example", purpose: "Test", success_state: "Checks pass", status: "active", repository: root,
      executor, verification: [{ id: "tests", command: ["npm", "test"] }] }] }));
    return file;
  };
  const config = loadWorkflowConfig(write({ kind: "claude", allowed_tools: ["Read", "Edit"] }));
  assert.equal(config.decision.kind, "claude");
  assert.equal(config.projects[0].executor.kind, "claude");
  assert.throws(() => loadWorkflowConfig(write({ kind: "claude", allowed_tools: "Read,Edit" })), /allowed_tools/);
  assert.throws(() => loadWorkflowConfig(write({ kind: "claude", allowed_tools: [] })), /allowed_tools/);
});
