import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateWorkflowConfig } from "../src/workflow/config.js";
import { HerdrRuntime, RuntimeRouter } from "../src/workflow/runtime.js";
import { Store } from "../src/workflow/store.js";
import { harness } from "./support/harness.js";

function fakeHerdr(root) {
  const filename = path.join(root, "fake-herdr.mjs");
  const log = path.join(root, "herdr-argv.jsonl");
  fs.writeFileSync(filename, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "machine" && args[1] === "status") {
  if (args[2] === "unavailable") { console.error("machine unreachable"); process.exit(23); }
  console.log(JSON.stringify({ id: "machine-17", status: "online", label: args[2] }));
} else if (args[0] === "--machine" && args[2] === "agent" && args[3] === "prompt") {
  fs.appendFileSync("feature.txt", "implemented: remote agent\\n");
  console.log(JSON.stringify({ execution_id: "remote-run-42", status: "completed", agent_id: args[4] }));
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
    job: { work: { title: "Do work" }, project_context: {} }, workspace: root, previous_failure: null,
    onRemoteStart: async (identity) => { started = identity; },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(started, { runtime: "herdr", machine_selector: "builder", agent_target: "agent-main", phase: "prompting",
    machine_status: { id: "machine-17", status: "online" } });
  assert.equal(result.remote_execution.execution_id, "remote-run-42");
  assert.equal(result.remote_execution.status, "completed");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls[0], ["machine", "status", "builder", "--json"]);
  assert.equal(calls[1][0], "--machine");
  assert.equal(calls[1][5].includes("Do work"), true);
  assert.equal(calls[1].length, 9);
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

test("recovery preserves remote identity and blocks only the interrupted project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-recovery-"));
  const store = new Store(root);
  store.change((data) => {
    data.projects.remote = { active: true };
    data.projects.local = { active: true };
    data.items.parent = { id: "parent", state: "Ready", revision: 1, history: [], input: { text: "remote work", source: "test" }, job_ids: ["remote-job"] };
    data.jobs["remote-job"] = { id: "remote-job", parent_id: "parent", project_id: "remote", state: "Executing", revision: 2, history: [], processes: [],
      attempts: [{ number: 1, execution: { passed: null, remote_execution: { runtime: "herdr", machine_selector: "builder", agent_target: "agent-main", phase: "prompting" } } }] };
  });
  fs.mkdirSync(store.workerLock);
  fs.writeFileSync(path.join(store.workerLock, "owner.json"), JSON.stringify({ pid: 99999999, hostname: os.hostname() }));
  const recovered = store.recover();
  assert.equal(recovered.jobs["remote-job"].state, "Blocked");
  assert.equal(recovered.jobs["remote-job"].attempts[0].execution.remote_execution.machine_selector, "builder");
  assert.equal(recovered.projects.remote.blocked, true);
  assert.notEqual(recovered.projects.local.blocked, true);
});
