import assert from "node:assert/strict";
import test from "node:test";
import {
  axiCapabilityGuidance,
  claudeCapabilityProbe,
  executionBranch,
  localExecutionPrompt,
  machineLocalPrompt,
  sharedWorktreePrompt,
} from "../src/workflow/runtime.js";

const job = {
  id: "job-1",
  agent_role: "general",
  work: { title: "Inspect", acceptance_criteria: [] },
  project_context: { agent_profile: { id: "general", name: "General", summary: "Implement the work.", skills: [], required_evidence: [] } },
};

function assertAxiGuidance(prompt) {
  assert.match(prompt, /low-token AXI interface `npx -y gh-axi`, represented by the argv prefix \["npx","-y","gh-axi"\]/);
  assert.match(prompt, /existing Git or GitHub CLI path/);
  assert.match(prompt, /low-token AXI interface `npx -y chrome-devtools-axi`, represented by the argv prefix \["npx","-y","chrome-devtools-axi"\]/);
  assert.match(prompt, /existing Playwright or browser tooling/);
  assert.match(prompt, /never construct shell source or interpolate request content into a shell command/);
  assert.match(prompt, /grant no authority to ship, approve, alter protected branches, perform destructive operations, change verification policy, or infer delivery intent/);
}

function assertHerdrControlPlane(prompt) {
  assert.match(prompt, /Herdr remains an execution runtime; Roundhouse remains the control plane/);
  assert.match(prompt, /owns policy, verification requirements, delivery intent, and approval for protected or destructive GitHub operations/);
  assert.match(prompt, /AXI availability does not expand the remote agent's authority/);
}

test("local execution prompt retains AXI preferences and explicit safe fallbacks", () => {
  assertAxiGuidance(axiCapabilityGuidance);
  assertAxiGuidance(localExecutionPrompt(job, "current isolated worktree", null, { id: "run-1" }));
});

test("shared-worktree Herdr prompt carries AXI fallbacks without changing control-plane authority", () => {
  const prompt = sharedWorktreePrompt(job, "/tmp/worktree", null, { id: "run-1" });
  assertAxiGuidance(prompt);
  assertHerdrControlPlane(prompt);
  assert.match(prompt, /Do not push, deploy/);
  assert.match(prompt, /Roundhouse owns commits, verification and delivery/);
});

test("machine-local Herdr prompt carries AXI fallbacks without broadening configured delivery", () => {
  const prompt = machineLocalPrompt({
    herdr: { working_directory: "/srv/project" },
    verification: [{ id: "tests", command: ["npm", "test"] }],
    policy: { shipping: "commit_only" },
  }, job, null, "token", { id: "run-1" });
  assertAxiGuidance(prompt);
  assertHerdrControlPlane(prompt);
  assert.match(prompt, /Commit the completed work on branch codex\/roundhouse-job-1\. Do not push it\./);
  assert.match(prompt, /Run the configured verification commands in that remote directory/);
});

test("Claude Herdr routing uses Claude delivery identity and requires each advertised capability gate", () => {
  const project = { executor: { kind: "claude" }, herdr: { working_directory: "/srv/project" },
    verification: [{ id: "tests", command: ["npm", "test"] }], policy: { shipping: "push_branch" }, remote: "origin" };
  assert.equal(executionBranch(project, job), "claude/roundhouse-job-1");
  assert.match(machineLocalPrompt(project, job, null, "nonce", { id: "run-1" }), /branch claude\/roundhouse-job-1/);
  const machine = { reachable: true, capabilities: { claude: { installed: true, version: "2.1.0", authenticated: true, quota_available: true, available: true } } };
  const agent = { kind: "claude", status: "idle", capabilities: { claude: { installed: true, version: "2.1.0", authenticated: true, quota_available: true, available: true } } };
  assert.deepEqual(claudeCapabilityProbe(machine, agent), { passed: true, phase: "ready", executor: "claude", version: "2.1.0", machine_version: "2.1.0", authenticated: true, quota_available: true, available: true });
  assert.equal(claudeCapabilityProbe({ reachable: false }, agent).phase, "machine_unavailable");
  assert.equal(claudeCapabilityProbe({ capabilities: machine.capabilities }, agent).phase, "machine_unavailable");
  assert.equal(claudeCapabilityProbe(machine, { ...agent, status: "offline" }).phase, "agent_unavailable");
  assert.equal(claudeCapabilityProbe(machine, { ...agent, status: undefined }).phase, "agent_unavailable");
  assert.equal(claudeCapabilityProbe(machine, { ...agent, kind: "general" }).passed, true);
  for (const [field, value, phase] of [
    ["installed", false, "claude_not_installed"], ["version", "", "claude_version_unavailable"],
    ["authenticated", false, "claude_authentication_failed"], ["quota_available", false, "claude_quota_unavailable"],
    ["available", false, "claude_unavailable"],
  ]) {
    const capability = { ...machine.capabilities.claude, [field]: value };
    assert.equal(claudeCapabilityProbe({ ...machine, capabilities: { claude: capability } }, agent).phase, phase);
  }
});

test("AXI guidance is argv-oriented and contains no shell wrapper examples", () => {
  assert.doesNotMatch(axiCapabilityGuidance, /(?:sh|bash|zsh)\s+-c/);
  assert.deepEqual(JSON.parse(axiCapabilityGuidance.match(/\["npx","-y","gh-axi"\]/)[0]), ["npx", "-y", "gh-axi"]);
  assert.deepEqual(JSON.parse(axiCapabilityGuidance.match(/\["npx","-y","chrome-devtools-axi"\]/)[0]), ["npx", "-y", "chrome-devtools-axi"]);
});
