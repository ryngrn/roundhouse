import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HerdrRuntime } from "../src/workflow/runtime.js";

function fakeHerdr(root, { authenticated = true, agentProbeError = "", placementResponse = null } = {}) {
  const filename = path.join(root, "herdr-fixture.mjs");
  const promptLog = path.join(root, "prompt.json");
  fs.writeFileSync(filename, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const capability = { installed: true, version: "2.1.9", authenticated: ${authenticated}, quota_available: true, available: true };
if (args[0] === "placement" && args[1] === "select") {
  const request = JSON.parse(await new Promise((resolve) => { let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => resolve(input)); }));
  console.log(JSON.stringify({ ...${JSON.stringify(placementResponse)}, request_version: request.version }));
}
else if (args[0] === "machine" && args[1] === "status") console.log(JSON.stringify({ reachable: true, capabilities: { claude: capability } }));
else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "get") {
  if (${JSON.stringify(agentProbeError)}) { console.error(${JSON.stringify(agentProbeError)}); process.exit(1); }
  console.log(JSON.stringify({ kind: "general", status: "idle", capabilities: { claude: capability } }));
}
else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "prompt") {
  fs.writeFileSync(${JSON.stringify(promptLog)}, JSON.stringify(args));
  console.log(JSON.stringify({ execution_id: "remote-claude-9", status: "completed" }));
} else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "read") {
  const prompt = JSON.parse(fs.readFileSync(${JSON.stringify(promptLog)}, "utf8"))[5];
  const token = prompt.match(/ROUNDHOUSE_RESULT_([0-9a-f-]+)=/)[1];
  console.log("ROUNDHOUSE_RESULT_" + token + "=" + JSON.stringify({ passed: true, summary: "Remote Claude completed.", commit: "a".repeat(40), branch: "claude/roundhouse-job-1", pushed: true, checks: [] }));
} else process.exit(64);
`);
  fs.chmodSync(filename, 0o700);
  return { filename, promptLog };
}

function request(root, bin, workspaceMode = "shared_worktree") {
  return {
    project: { id: "remote", runtime: "herdr", executor: { kind: "claude" }, timeout_ms: 10_000,
      verification: [], policy: { shipping: "push_branch" }, remote: "origin",
      herdr: { bin, machine: "iMac", agent: "claude-worker", workspace_mode: workspaceMode, working_directory: "/srv/project" } },
    job: { id: "job-1", work: { title: "Bounded work", acceptance_criteria: [] },
      project_context: { purpose: "Fixture", agent_profile: { id: "general", name: "General", summary: "Implement.", skills: [], required_evidence: [] } } },
    workspace: root, directory: path.join(root, "evidence"), previous_failure: { failure: "prior failure" },
    run: { id: "run-1" }, onStart: () => {},
  };
}

test("Herdr dispatches Claude only after advertised capability probes and preserves remote identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-claude-"));
  const fixture = fakeHerdr(root);
  const result = await new HerdrRuntime().execute(request(root, fixture.filename));
  assert.equal(result.passed, true);
  assert.equal(result.remote_execution.executor, "claude");
  assert.equal(result.remote_execution.execution_id, "remote-claude-9");
  assert.equal(result.remote_execution.capability_probe.phase, "ready");
  assert.deepEqual(result.remote_execution.placement.authority, { control_plane: "roundhouse", placement: "herdr" });
  assert.equal(result.remote_execution.placement.selection.machine, "iMac");
  assert.equal(result.remote_execution.placement.selection.tool, "claude");
  assert.match(result.remote_execution.dispatch_nonce, /^[0-9a-f-]{36}$/);
  assert.equal(Object.hasOwn(result.remote_execution, "pid"), false);
  const prompt = JSON.parse(fs.readFileSync(fixture.promptLog, "utf8"))[5];
  assert.match(prompt, /Bounded work/);
  assert.match(prompt, /prior failure/);
  assert.match(prompt, /npx -y gh-axi/);
  assert.match(prompt, /Roundhouse owns commits, verification and delivery/);
});

test("Herdr selects and validates a policy-bounded placement before probing or dispatching", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-placement-"));
  const selected = { runtime: "herdr", machine: "Studio-iMac", platform: "macos", tool: "claude",
    agent: "fleet-worker", capabilities: ["repository", "browser"], available: true };
  const fixture = fakeHerdr(root, { placementResponse: { eligible: [selected], selection: selected,
    rationale: "Selected the available macOS Claude worker.", source: "herdr_scheduler", observed_at: "2026-10-08T00:00:00.000Z" } });
  const input = request(root, fixture.filename);
  delete input.project.herdr.machine;
  delete input.project.herdr.agent;
  input.project.required_capabilities = ["repository"];
  input.project.herdr.placement = { machine_selectors: ["Studio-iMac"], platforms: ["macos"], tools: ["claude"],
    agents: ["fleet-worker"], capabilities: ["browser"] };
  let persisted;
  const result = await new HerdrRuntime().execute({ ...input, onPlacement: (placement) => { persisted = placement; } });
  assert.equal(result.passed, true);
  assert.equal(result.remote_execution.machine_selector, "Studio-iMac");
  assert.equal(result.remote_execution.agent_target, "fleet-worker");
  assert.equal(result.remote_execution.placement.selection.source, "herdr_scheduler");
  assert.deepEqual(persisted, result.remote_execution.placement);
  assert.equal(result.remote_execution.placement_request.passed, true);
});

test("Herdr holds work when dynamic placement has no eligible target and never falls back", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-placement-hold-"));
  const fixture = fakeHerdr(root, { placementResponse: { eligible: [], selection: null,
    hold: { reason: "No online macOS worker advertises browser." }, source: "herdr_scheduler" } });
  const input = request(root, fixture.filename);
  input.project.herdr.placement = { machine_selectors: ["iMac"], platforms: ["macos"], tools: ["claude"],
    agents: ["claude-worker"], capabilities: ["browser"] };
  const result = await new HerdrRuntime().execute(input);
  assert.equal(result.passed, false);
  assert.equal(result.remote_execution.phase, "missing_capability");
  assert.equal(result.remote_execution.placement.selection, null);
  assert.match(result.remote_execution.placement.hold.reason, /No online macOS worker/);
  assert.equal(fs.existsSync(fixture.promptLog), false);
});

test("Herdr records Claude authentication failure without dispatching work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-claude-auth-"));
  const fixture = fakeHerdr(root, { authenticated: false });
  const result = await new HerdrRuntime().execute(request(root, fixture.filename));
  assert.equal(result.passed, false);
  assert.equal(result.remote_execution.phase, "claude_authentication_failed");
  assert.equal(result.remote_execution.placement.selection, null);
  assert.equal(result.remote_execution.placement.hold.code, "missing_capability");
  assert.match(result.remote_execution.placement.hold.reason, /authentication/i);
  assert.equal(fs.existsSync(fixture.promptLog), false);
});

test("Herdr classifies an unavailable Claude agent before dispatch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-claude-agent-"));
  const fixture = fakeHerdr(root, { agentProbeError: "agent offline" });
  const result = await new HerdrRuntime().execute(request(root, fixture.filename));
  assert.equal(result.passed, false);
  assert.equal(result.remote_execution.phase, "agent_unavailable");
  assert.equal(result.remote_execution.placement.selection, null);
  assert.equal(result.remote_execution.placement.hold.code, "placement_unavailable");
  assert.equal(fs.existsSync(fixture.promptLog), false);
});

test("machine-local Claude evidence is correlated to remote identity without a client pid", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-claude-local-"));
  const fixture = fakeHerdr(root);
  let started;
  const result = await new HerdrRuntime().execute({ ...request(root, fixture.filename, "machine_local"),
    onRemoteStart: (identity) => { started = identity; } });
  assert.equal(result.passed, true);
  assert.equal(result.remote_report.summary, "Remote Claude completed.");
  assert.equal(result.remote_execution.dispatch_nonce, started.dispatch_nonce);
  assert.equal(result.remote_execution.report_token, started.dispatch_nonce);
  assert.equal(result.remote_execution.execution_id, "remote-claude-9");
  assert.equal(Object.hasOwn(result.remote_execution, "pid"), false);
});
