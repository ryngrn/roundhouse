import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateWorkflowConfig } from "../src/workflow/config.js";
import { claudeDecisionArgs, decisionSchema } from "../src/workflow/decision.js";
import { claudeDefaultTools, claudeExecutorArgs, claudeResult } from "../src/workflow/runtime.js";
import { externallyUncertain, providerCapabilities, providerCapabilityEvidence, providerContract, providerFailureEvidence,
  providerAdvertisement, providerIdentity, validateProviderSelection } from "../src/workflow/provider-contract.js";
import { herdrPlacementRequirements, staticHerdrPlacement, validateHerdrPlacement } from "../src/workflow/placement-contract.js";

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

test("provider audit evidence is capability-specific and excludes executable or credential configuration", () => {
  const configured = { id: "private-provider", kind: "command", capabilities: ["decision", "execution"],
    command: ["agent", "--token", "secret"], api_key: "secret", reasoning: "private" };
  assert.deepEqual(providerIdentity(configured), {
    id: "private-provider", kind: "command", capabilities: ["decision", "execution"],
  });
  const evidence = providerCapabilityEvidence([configured], ["execution", "artifact"], null);
  assert.deepEqual(evidence.capability_probe.results, [{ provider_id: "private-provider",
    required: ["execution", "artifact"], missing: ["artifact"], supported: false }]);
  assert.equal(JSON.stringify(evidence).includes("secret"), false);
  assert.equal(JSON.stringify(evidence).includes("reasoning"), false);
});

test("provider fallback requires explicit safe pre-action failure evidence", () => {
  assert.deepEqual(providerFailureEvidence({ provider_failure: { code: "quota_exhausted", replay_safe: true,
    dependency: "model quota" } }), {
    category: "quota", code: "quota_exhausted", dependency: "model quota", message: null,
    action_status: null, fallback_eligible: true,
  });
  assert.equal(providerFailureEvidence({ provider_failure: { category: "availability" } }).fallback_eligible, false);
  assert.equal(externallyUncertain({ provider_failure: { category: "availability", action_status: "uncertain" } }), true);
});

test("live provider advertisements are bounded by configured capabilities", () => {
  const configured = { id: "local-model", capabilities: ["research", "artifact"] };
  assert.deepEqual(providerAdvertisement({ available: true, capabilities: ["research", "unconfigured"], confidence: 0.91,
    node_id: "studio" }, configured, ["research", "artifact"]), {
    provider_id: "local-model", available: true, capabilities: ["research"], required: ["research", "artifact"],
    missing: ["artifact"], confidence: 0.91, eligible: false,
    reason: "Provider does not currently advertise: artifact.", node_id: "studio",
  });
  assert.equal(providerFailureEvidence({ provider_failure: { category: "confidence", safe_to_retry: true } }).category, "confidence");
  assert.equal(providerFailureEvidence({ provider_failure: { code: "insufficient_capability", action_status: "not_started" } }).category, "capability");
  assert.deepEqual(providerAdvertisement({ available: true, capabilities: ["research"], confidence: 0.6 },
    { id: "local-model", capabilities: ["research"], min_confidence: 0.8 }, ["research"]), {
    provider_id: "local-model", available: true, capabilities: ["research"], required: ["research"], missing: [],
    confidence: 0.6, eligible: false, reason: "Provider confidence 0.6 is below the configured threshold 0.8.",
  });
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

test("Herdr placement evidence preserves Roundhouse policy authority and validates selection evidence", () => {
  const project = { runtime: "herdr", required_capabilities: ["repository"], executor: { kind: "claude" },
    herdr: { machine: "Studio-iMac", agent: "general-worker", placement: {
      machine_selectors: ["Studio-iMac"], platforms: ["macos"], tools: ["claude"], agents: ["general-worker"], capabilities: ["browser"],
    } } };
  const job = { work: { required_capabilities: ["repository", "visual-review"] } };
  const requirements = herdrPlacementRequirements(project, job);
  assert.deepEqual(requirements.capabilities, ["repository", "visual-review", "browser"]);
  const selected = { runtime: "herdr", machine: "Studio-iMac", platform: "macos", tool: "claude", agent: "general-worker",
    capabilities: ["repository", "visual-review", "browser"], available: true };
  const evidence = validateHerdrPlacement({ requirements, eligible: [selected], selection: selected,
    rationale: "Machine advertises every required capability.", source: "herdr_scheduler", observed_at: "2026-10-08T00:00:00.000Z" });
  assert.deepEqual(evidence.authority, { control_plane: "roundhouse", placement: "herdr" });
  assert.deepEqual(evidence.selection.matched_capabilities, requirements.capabilities);
  assert.equal(evidence.selection.source, "herdr_scheduler");
  assert.equal(evidence.hold, null);
  assert.throws(() => validateHerdrPlacement({ requirements, eligible: [selected],
    selection: { ...selected, tool: "codex" }, rationale: "Request asked for Codex.", source: "request_label" }),
  /eligible advertised placements/);
  assert.throws(() => validateHerdrPlacement({ requirements, eligible: [{ ...selected, capabilities: [] }], selection: selected,
    rationale: "Selection claimed capabilities the machine did not advertise.", source: "herdr_scheduler" }),
  /capabilities must match its eligible advertisement/);
  assert.throws(() => validateHerdrPlacement({ requirements, eligible: [{ ...selected, runtime: "local" }],
    selection: { ...selected, runtime: "local" }, rationale: "Wrong runtime.", source: "herdr_scheduler" }),
  /outside Roundhouse project policy/);
});

test("static Herdr projects adapt to placement evidence and unavailable placement records a precise hold", () => {
  const project = { runtime: "herdr", required_capabilities: ["local"], executor: { kind: "codex" },
    herdr: { machine: "iMac", agent: "roundhouse-imac" } };
  const evidence = staticHerdrPlacement(project, null, { observed_at: "2026-10-08T00:00:00.000Z" });
  assert.equal(evidence.selection.machine, "iMac");
  assert.equal(evidence.selection.platform, "herdr");
  assert.equal(evidence.selection.tool, "codex");
  assert.equal(evidence.selection.source, "static_project_config");
  const held = validateHerdrPlacement({ requirements: evidence.requirements, eligible: [], observed_at: "2026-10-08T00:00:00.000Z" });
  assert.deepEqual(held.hold, { code: "missing_capability", reason: "No eligible Herdr placement advertises: local.", missing_capabilities: ["local"] });
  const unavailable = validateHerdrPlacement({ requirements: evidence.requirements,
    eligible: [{ runtime: "herdr", machine: "iMac", platform: "herdr", tool: "codex", agent: "roundhouse-imac",
      capabilities: ["local"], available: false }], observed_at: "2026-10-08T00:00:00.000Z" });
  assert.deepEqual(unavailable.hold, { code: "placement_unavailable",
    reason: "No configured Herdr placement is currently available.", missing_capabilities: [] });
});

test("Herdr placement configuration is operator-owned and remains compatible with static machine and agent fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-placement-config-"));
  const config = validateWorkflowConfig(manifest(root, { runtime: "herdr", executor: { kind: "claude" },
    herdr: { machine: "Studio-iMac", agent: "worker", placement: { machine_selectors: ["Studio-iMac"],
      platforms: ["macos"], tools: ["claude"], agents: ["worker"], capabilities: ["browser"] } } }), path.join(root, "placement.yaml"));
  assert.deepEqual(config.projects[0].herdr.placement.platforms, ["macos"]);
  const dynamic = validateWorkflowConfig(manifest(root, { runtime: "herdr", executor: { kind: "claude" },
    herdr: { placement: { machine_selectors: ["Studio-iMac"], platforms: ["macos"], tools: ["claude"],
      agents: ["worker"], capabilities: ["browser"] } } }), path.join(root, "dynamic-placement.yaml"));
  assert.equal(dynamic.projects[0].herdr.machine, undefined);
  assert.throws(() => validateWorkflowConfig(manifest(root, { runtime: "herdr", executor: { kind: "claude" },
    herdr: { machine: "Studio-iMac", agent: "worker", placement: { tools: ["codex"] } } }), path.join(root, "bad-placement.yaml")),
  /executor must satisfy herdr.placement.tools/);
});
