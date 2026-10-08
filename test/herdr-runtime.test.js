import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateWorkflowConfig } from "../src/workflow/config.js";
import { HerdrRuntime, RuntimeRouter } from "../src/workflow/runtime.js";
import { Store } from "../src/workflow/store.js";
import { harness } from "./support/harness.js";

function fakeHerdr(root, { startupState = "working" } = {}) {
  const filename = path.join(root, "fake-herdr.mjs");
  const log = path.join(root, "herdr-argv.jsonl");
  fs.writeFileSync(filename, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "machine" && args[1] === "status") {
  if (args[2] === "unavailable") { console.error("machine unreachable"); process.exit(23); }
  console.log(JSON.stringify({ id: "machine-17", status: "online", label: args[2] }));
} else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "get") {
  console.log(JSON.stringify({ result: { agent: { agent_status: "idle" } } }));
} else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "wait") {
  const state = args.includes("working") ? ${JSON.stringify(startupState)} : "done";
  console.log(JSON.stringify({ execution_id: "remote-run-42", status: "completed", result: { agent: { agent_status: state } } }));
} else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "prompt") {
  fs.appendFileSync("feature.txt", "implemented: remote agent\\n");
  console.log(JSON.stringify({ execution_id: "remote-run-42", status: "completed", agent_id: args[4] }));
} else process.exit(64);
`);
  fs.chmodSync(filename, 0o700);
  return { filename, log };
}

function fakeMachineLocalHerdr(root, { report = true } = {}) {
  const filename = path.join(root, `fake-machine-local-herdr-${report}.mjs`);
  const log = path.join(root, `machine-local-herdr-${report}.jsonl`);
  const output = path.join(root, `machine-local-result-${report}.txt`);
  fs.writeFileSync(filename, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "machine" && args[1] === "status") {
  console.log(JSON.stringify({ id: "imac-id", status: "online", label: args[2] }));
} else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "get") {
  console.log(JSON.stringify({ result: { agent: { agent_status: "idle" } } }));
} else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "wait") {
  console.log(JSON.stringify({ result: { agent: { agent_status: args.includes("working") ? "working" : "done" } } }));
} else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "prompt") {
  const prompt = args[5];
  const token = prompt.match(/ROUNDHOUSE_RESULT_([0-9a-f-]+)=/)[1];
  const branch = prompt.match(/branch (codex\\/roundhouse-[a-z0-9-]+)/)[1];
  if (${JSON.stringify(report)}) fs.writeFileSync(${JSON.stringify(output)}, "ROUNDHOUSE_RESULT_" + token + "=" + JSON.stringify({
    passed: true, summary: "Remote checks, commit, and delivery completed.", commit: "a".repeat(40), branch, pushed: true,
    checks: [{ id: "feature", passed: true, summary: "Remote feature check passed." }]
  }));
  console.log(JSON.stringify({ result: { agent: { id: "remote-agent-id", status: "idle", completion_seq: 12 } } }));
} else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "read") {
  if (fs.existsSync(${JSON.stringify(output)})) process.stdout.write(fs.readFileSync(${JSON.stringify(output)}, "utf8"));
} else process.exit(64);
`);
  fs.chmodSync(filename, 0o700);
  return { filename, log };
}

function minimalProject(repository, extra = {}) {
  return { id: "example", name: "Example", purpose: "Test", success_state: "Done", status: "active", repository,
    verification: [{ id: "test", command: ["true"] }], ...extra };
}

test("Herdr config is explicit while local remains the default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-config-"));
  const filename = path.join(root, "config.yaml");
  assert.equal(validateWorkflowConfig({ projects: [minimalProject(root)] }, filename).projects[0].runtime, "local");
  assert.throws(() => validateWorkflowConfig({ projects: [minimalProject(root, { runtime: "herdr" })] }, filename), /requires herdr configuration/);
  assert.throws(() => validateWorkflowConfig({ projects: [minimalProject(root, { runtime: "herdr", herdr: { machine: " ", agent: "agent" } })] }, filename), /nonempty herdr.machine/);
  assert.throws(() => validateWorkflowConfig({ projects: [minimalProject(root, { herdr: { machine: "host", agent: "agent" } })] }, filename), /cannot configure herdr/);
  const project = validateWorkflowConfig({ projects: [minimalProject(root, { runtime: "herdr", herdr: { machine: "host", agent: "agent" } })] }, filename).projects[0];
  assert.equal(project.herdr.agent, "agent");
  assert.equal(project.herdr.workspace_mode, "shared_worktree");
  assert.throws(() => validateWorkflowConfig({ projects: [minimalProject(root, { repository: undefined, runtime: "herdr", herdr: { machine: "iMac", agent: "roundhouse-imac", workspace_mode: "machine_local" } })] }, filename), /requires a nonempty herdr.working_directory/);
  assert.throws(() => validateWorkflowConfig({ projects: [minimalProject(root, { repository: undefined, runtime: "herdr", herdr: { machine: "iMac", agent: "roundhouse-imac", workspace_mode: "machine_local", working_directory: "relative/repo" } })] }, filename), /must be absolute/);
  const machineLocal = validateWorkflowConfig({ projects: [minimalProject(root, { repository: undefined, runtime: "herdr", herdr: { machine: "iMac", agent: "roundhouse-imac", workspace_mode: "machine_local", working_directory: "/home/ryngrn/kmac" } })] }, filename).projects[0];
  assert.equal(machineLocal.repository, null);
  assert.equal(machineLocal.herdr.working_directory, "/home/ryngrn/kmac");
});

test("runtime router preserves local routing and selects Herdr only when configured", async () => {
  const calls = [];
  const router = new RuntimeRouter({
    local: { execute: async () => { calls.push("local"); return { passed: true }; } },
    herdr: { execute: async () => { calls.push("herdr"); return { passed: true }; } },
  });
  await router.execute({ project: { runtime: "local" } });
  await router.execute({ project: { runtime: "herdr" } });
  assert.deepEqual(calls, ["local", "herdr"]);
});

test("Herdr probes first, passes the prompt as one argv value, and returns correlated identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-runtime-"));
  const { filename, log } = fakeHerdr(root);
  let started;
  const result = await new HerdrRuntime().execute({
    project: { timeout_ms: 10_000, herdr: { bin: filename, machine: "builder", agent: "agent-main" } },
    job: { work: { title: "Do work" }, project_context: {}, request_context: {
      original_request: "# Original request\n\nPreserve the user's structured intent.",
      conversation: { link: "chatgpt://conversation/example", live_context: { messages: [{ role: "user", text: "Newest constraint." }] } },
    } }, workspace: root, previous_failure: null,
    onRemoteStart: async (identity) => { started = identity; },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(started, { runtime: "herdr", machine_selector: "builder", agent_target: "agent-main", workspace_mode: "shared_worktree", phase: "prompting",
    machine_status: { id: "machine-17", status: "online" } });
  assert.equal(result.remote_execution.execution_id, "remote-run-42");
  assert.equal(result.remote_execution.status, "completed");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls[0], ["machine", "status", "builder", "--json"]);
  assert.deepEqual(calls.map((args) => args[3]).slice(1), ["get", "prompt", "wait", "wait"]);
  assert.equal(calls[2][0], "--machine");
  assert.equal(calls[2][5].includes("Do work"), true);
  assert.match(calls[2][5], /# Original request\n\nPreserve the user's structured intent\./);
  assert.match(calls[2][5], /Newest constraint\./);
  assert.ok(calls[2][5].indexOf("# Original request") < calls[2][5].indexOf("Do work"));
  assert.equal(calls[2].length, 6);
  assert.equal(calls.filter((args) => args[3] === "prompt").length, 1);
  assert.deepEqual(calls.filter((args) => args[3] === "wait").map((args) => args.slice(5, 9)),
    [["--until", "working", "--until", "blocked"], ["--until", "idle", "--until", "done"]]);
});

test("Herdr does not replay submitted prompts when startup is blocked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-approval-"));
  const { filename, log } = fakeHerdr(root, { startupState: "blocked" });
  const result = await new HerdrRuntime().execute({
    project: { timeout_ms: 10_000, herdr: { bin: filename, machine: "builder", agent: "agent-main" } },
    job: { work: { title: "Remote work with approval" }, project_context: {} },
    workspace: root, previous_failure: null,
  });
  assert.equal(result.passed, false);
  assert.equal(result.remote_execution.phase, "agent_blocked");
  assert.equal(result.remote_execution.prompt_submitted, true);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((args) => args[3] === "prompt").length, 1);
  assert.equal(calls.filter((args) => args[3] === "wait").length, 1);
});

test("machine-local Herdr dispatch names the remote directory and collects correlated evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-machine-local-runtime-"));
  const { filename, log } = fakeMachineLocalHerdr(root);
  const result = await new HerdrRuntime().execute({
    project: { timeout_ms: 10_000, remote: "origin", policy: { shipping: "push_branch" },
      verification: [{ id: "feature", command: ["npm", "test"] }],
      herdr: { bin: filename, machine: "iMac", agent: "roundhouse-imac", workspace_mode: "machine_local", working_directory: "/home/ryngrn/kmac" } },
    job: { id: "job-1", work: { title: "Do remote work" }, project_context: {} }, directory: path.join(root, "execution"), previous_failure: null,
  });
  assert.equal(result.passed, true);
  assert.equal(result.remote_report.commit, "a".repeat(40));
  assert.equal(result.remote_execution.working_directory, "/home/ryngrn/kmac");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 6);
  assert.match(calls[2][5], /directly on the remote machine in the existing repository at \/home\/ryngrn\/kmac/);
  assert.match(calls[2][5], /do not use or infer any Studio\/Roundhouse-local path/);
  assert.deepEqual(calls[5].slice(0, 5), ["--machine", "iMac", "agent", "read", "roundhouse-imac"]);
});

test("unavailable Herdr machine blocks explicitly without fallback while local project progresses", async () => {
  const h = harness();
  const { filename, log } = fakeHerdr(h.root);
  const base = h.config.projects[0];
  h.config.projects = [
    { ...base, id: "a-remote", runtime: "herdr", policy: { ...base.policy, max_rework_attempts: 0 }, herdr: { bin: filename, machine: "unavailable", agent: "agent-main" } },
    { ...base, id: "z-local", runtime: "local" },
  ];
  h.store.submit({ text: "remote task", project_id: "a-remote", source: "fixture", actor: "test" }, "remote-task");
  h.store.submit({ text: "local task", project_id: "z-local", source: "fixture", actor: "test" }, "local-task");
  const result = await h.engine.run();
  const remote = Object.values(result.jobs).find((job) => job.project_id === "a-remote");
  const local = Object.values(result.jobs).find((job) => job.project_id === "z-local");
  assert.equal(remote.state, "Blocked");
  assert.equal(remote.attempts[0].execution.remote_execution.machine_selector, "unavailable");
  assert.match(remote.attempts[0].failure, /machine probe failed/);
  assert.equal(local.state, "Shipped");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["machine", "status", "unavailable", "--json"]);
});

test("successful Herdr execution identity is persisted on the attempt", async () => {
  const h = harness();
  const { filename } = fakeHerdr(h.root);
  h.config.projects[0].runtime = "herdr";
  h.config.projects[0].herdr = { bin: filename, machine: "builder", agent: "agent-main" };
  h.submit("remote success");
  const result = await h.engine.run();
  const attempt = Object.values(result.jobs)[0].attempts[0];
  assert.equal(attempt.execution.remote_execution.machine_selector, "builder");
  assert.equal(attempt.execution.remote_execution.agent_target, "agent-main");
  assert.equal(attempt.execution.remote_execution.execution_id, "remote-run-42");
  assert.equal(Object.values(result.jobs)[0].state, "Shipped");
});

test("machine-local completion ships only from remote evidence and never prepares a local worktree", async () => {
  const h = harness({ policy: { max_rework_attempts: 2 } });
  const { filename, log } = fakeMachineLocalHerdr(h.root);
  h.config.projects[0].runtime = "herdr";
  h.config.projects[0].herdr = { bin: filename, machine: "iMac", agent: "roundhouse-imac", workspace_mode: "machine_local", working_directory: "/home/ryngrn/kmac" };
  h.config.projects[0].repository = null;
  h.config.projects[0].context_sources = [];
  h.submit("remote machine-local success");
  const result = await h.engine.run();
  const job = Object.values(result.jobs)[0];
  assert.equal(job.state, "Shipped", JSON.stringify(job));
  assert.equal(job.prepared.workspace, undefined);
  assert.equal(job.prepared.working_directory, "/home/ryngrn/kmac");
  assert.equal(job.attempts[0].verification.independently_verified, false);
  assert.equal(job.shipping.source, "remote_agent_report");
  assert.equal(job.shipping.commit, "a".repeat(40));
  assert.equal(job.delivery_intent.machine_selector, "iMac");
  assert.equal(fs.existsSync(path.join(h.repository, "feature.txt")), false);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 6);
});

test("machine-local missing evidence blocks without local fallback or prompt replay", async () => {
  const h = harness({ policy: { max_rework_attempts: 3 } });
  const { filename, log } = fakeMachineLocalHerdr(h.root, { report: false });
  h.config.projects[0].runtime = "herdr";
  h.config.projects[0].herdr = { bin: filename, machine: "iMac", agent: "roundhouse-imac", workspace_mode: "machine_local", working_directory: "/home/ryngrn/kmac" };
  h.submit("remote evidence failure");
  const result = await h.engine.run();
  const job = Object.values(result.jobs)[0];
  assert.equal(job.state, "Blocked");
  assert.equal(job.attempts.length, 1);
  assert.match(job.attempts[0].failure, /no valid correlated completion report/);
  assert.equal(fs.existsSync(path.join(h.repository, "feature.txt")), false);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((args) => args[3] === "prompt").length, 1);
  const reconciled = await h.engine.reconcileJob(job.id, { actor: "operator", note: "Inspected the iMac repository and confirmed the remote branch.",
    commit: "b".repeat(40), branch: `codex/roundhouse-${job.id}` });
  assert.equal(reconciled.state, "Shipped");
  assert.equal(reconciled.shipping.source, "operator_remote_attestation");
  assert.equal(reconciled.shipping.verification.independently_verified, false);
});

test("recovery preserves remote identity and blocks only the interrupted project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-recovery-"));
  const store = new Store(root);
  store.change((data) => {
    data.projects.remote = { active: true };
    data.projects.local = { active: true };
    data.items.parent = { id: "parent", state: "Ready", revision: 1, history: [], input: { text: "remote work", source: "test" }, job_ids: ["remote-job"] };
    data.jobs["remote-job"] = { id: "remote-job", parent_id: "parent", project_id: "remote", state: "Executing", revision: 2, history: [], processes: [],
      attempts: [{ number: 1, execution: { passed: null, remote_execution: { runtime: "herdr", machine_selector: "iMac", agent_target: "roundhouse-imac", workspace_mode: "machine_local", working_directory: "/home/ryngrn/kmac", phase: "prompting" } } }] };
  });
  fs.mkdirSync(store.workerLock);
  fs.writeFileSync(path.join(store.workerLock, "owner.json"), JSON.stringify({ pid: 99999999, hostname: os.hostname() }));
  const recovered = store.recover();
  assert.equal(recovered.jobs["remote-job"].state, "Blocked");
  assert.equal(recovered.jobs["remote-job"].attempts[0].execution.remote_execution.machine_selector, "iMac");
  assert.equal(recovered.jobs["remote-job"].attempts[0].execution.remote_execution.working_directory, "/home/ryngrn/kmac");
  assert.equal(recovered.projects.remote.blocked, true);
  assert.notEqual(recovered.projects.local.blocked, true);
});
