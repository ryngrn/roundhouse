import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateWorkflowConfig } from "../src/workflow/config.js";
import { claudeDecisionArgs, decisionSchema } from "../src/workflow/decision.js";
import { claudeDefaultTools, claudeExecutorArgs, claudeResult } from "../src/workflow/runtime.js";
import { providerCapabilities, providerContract, validateProviderSelection } from "../src/workflow/provider-contract.js";

function manifest(root, changes = {}) {
  return { projects: [{ id: "example", name: "Example", purpose: "Exercise provider contracts", success_state: "Checks pass",
    status: "active", repository: root, verification: [{ id: "tests", command: ["npm", "test"] }], ...changes }] };
}

test("provider contract separates decision, conversation, and execution capabilities", () => {
  assert.deepEqual(providerCapabilities, ["decision", "conversation", "execution"]);
  assert.deepEqual(providerContract("codex").capabilities, providerCapabilities);
  assert.deepEqual(providerContract("claude").capabilities, providerCapabilities);
  assert.deepEqual(providerContract("command").capabilities, ["decision", "execution"]);
  assert.throws(() => validateProviderSelection({ kind: "command", command: ["agent"] }, "conversation", "Conversation provider"), /does not support the conversation capability/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-provider-conversation-"));
  const config = validateWorkflowConfig({ ...manifest(root), conversation: { kind: "claude", bin: "/opt/claude" } }, path.join(root, "conversation.yaml"));
  assert.deepEqual(config.conversation, { kind: "claude", bin: "/opt/claude" });
});

test("legacy Codex defaults and explicit Codex configuration remain unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-provider-codex-"));
  const defaults = validateWorkflowConfig(manifest(root), path.join(root, "defaults.yaml"));
  assert.deepEqual(defaults.decision, { kind: "codex", bin: "codex" });
  assert.deepEqual(defaults.projects[0].executor, { kind: "codex", bin: "codex" });
  const explicit = validateWorkflowConfig({ ...manifest(root, { executor: { kind: "codex", bin: "/opt/codex" } }),
    decision: { kind: "codex", bin: "/opt/codex" } }, path.join(root, "explicit.yaml"));
  assert.deepEqual(explicit.decision, { kind: "codex", bin: "/opt/codex" });
  assert.deepEqual(explicit.projects[0].executor, { kind: "codex", bin: "/opt/codex" });
});

test("supported Claude configuration keeps safe decision and execution behavior", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-provider-claude-"));
  const config = validateWorkflowConfig({ ...manifest(root, { executor: { kind: "claude", bin: "/opt/claude", allowed_tools: ["Read", "Edit"] } }),
    decision: { kind: "claude", bin: "/opt/claude" } }, path.join(root, "claude.yaml"));
  assert.deepEqual(config.decision, { kind: "claude", bin: "/opt/claude" });
  assert.deepEqual(config.projects[0].executor.allowed_tools, ["Read", "Edit"]);
  assert.deepEqual(claudeExecutorArgs({ kind: "claude" }), ["claude", "-p", "--output-format", "json", "--no-session-persistence",
    "--permission-mode", "acceptEdits", "--allowedTools", claudeDefaultTools.join(",")]);
  const decisionArgs = claudeDecisionArgs({ kind: "claude" });
  assert.deepEqual(decisionArgs.slice(decisionArgs.indexOf("--tools"), decisionArgs.indexOf("--tools") + 2), ["--tools", ""]);
  assert.deepEqual(JSON.parse(decisionArgs[decisionArgs.indexOf("--json-schema") + 1]), decisionSchema);
  assert.deepEqual(claudeResult(JSON.stringify({ is_error: false, result: "Done", structured_output: { ok: true } })),
    { is_error: false, summary: "Done", structured_output: { ok: true } });
  assert.equal(claudeResult("not json").is_error, true);
});

test("unsupported provider, capability, runtime, tool, and fallback combinations are actionable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-provider-invalid-"));
  const filename = path.join(root, "invalid.yaml");
  assert.throws(() => validateWorkflowConfig({ ...manifest(root), decision: { kind: "other" } }, filename), /unsupported; expected codex, claude, or command/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(root), decision: { kind: "codex", capabilities: ["execution"] } }, filename), /must include decision/);
  assert.throws(() => validateWorkflowConfig(manifest(root, { runtime: "cloud" }), filename), /Runtime must be local or herdr/);
  assert.throws(() => validateWorkflowConfig(manifest(root, { executor: { kind: "codex", allowed_tools: ["Read"] } }), filename), /only by the claude provider/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(root), decision: { kind: "claude", fallback: "codex" } }, filename), /does not switch providers implicitly/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(root), conversation: { kind: "command", command: ["chat"] } }, filename), /does not support the conversation capability/);
  assert.throws(() => validateWorkflowConfig(manifest(root, { executor: { kind: "claude", allowed_tools: [] } }), filename), /allowed_tools/);
});
