import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { harness, provider } from "./support/harness.js";
import { Engine } from "../src/workflow/engine.js";
import { Store } from "../src/workflow/store.js";
import { git } from "../src/workflow/delivery.js";
import { GitDelivery } from "../src/workflow/delivery.js";
import { statusView } from "../src/workflow/cli.js";
import { once } from "node:events";

function schedulingProject(id, weight = 1) {
  return {
    id, status: "active", weight, max_concurrent_runs: 1, required_capabilities: [], resource_requirements: {},
    policy: { continuation: "continue_project_queue" },
  };
}

function schedulingJob(id, projectId, position, { state = "Ready", dependencies = [], priority = 100 } = {}) {
  return { id, project_id: projectId, position, state, dependencies, priority_rank: priority, attempts: [], processes: [], history: [] };
}

function schedulingEngine(store, projects, selected, maxJobs = 1) {
  const engine = new Engine({
    store,
    config: { projects, max_jobs_per_run: maxJobs, execution: { capacity: 1, capabilities: [], resource_limits: {} }, triage: {} },
    shipping: { canDispatch: () => true },
  });
  engine.execute = async (id, project) => {
    selected.push(id);
    store.change((data) => {
      data.jobs[id].state = "Shipped";
      data.projects[project.id] = { ...data.projects[project.id], active: false };
    });
    return true;
  };
  return engine;
}

test("e2e: autonomous Depot request creates actual change, verifies exact commit, pushes, and never enters Review", async () => {
  const h = harness();
  const item = h.submit("first useful change");
  const result = await h.engine.run();
  const job = Object.values(result.jobs)[0];
  assert.equal(job.state, "Shipped");
  assert.equal(job.shipping.pushed, true);
  assert.equal(git(h.remote, ["rev-parse", job.shipping.branch]), job.shipping.commit);
  assert.match(git(h.remote, ["show", `${job.shipping.commit}:feature.txt`]), /first useful change/);
  assert.equal(job.attempts[0].verification.commit, job.shipping.commit);
  assert.ok(job.attempts[0].verification.checks.every((c) => c.passed));
  assert.ok(!job.history.some((e) => e.to === "Review"));
  assert.equal(statusView(result).items.find((i) => i.id === item.id).state, "Shipped");
  assert.equal(git(h.repository, ["branch", "--show-current"]), "main");
  assert.equal(git(h.repository, ["status", "--porcelain"]), "");
  const persisted = new Store(h.store.directory).read();
  assert.equal(persisted.jobs[job.id].shipping.commit, job.shipping.commit);
  assert.equal((await h.engine.run()).executed, 0);
});
test("e2e: low confidence asks for clarification without creating work or shipping", async () => {
  const h = harness(); h.submit("ambiguous idea");
  const result = await h.engine.run();
  assert.equal(Object.values(result.items)[0].state, "Needs Clarification");
  assert.equal(Object.keys(result.jobs).length, 0);
  assert.equal(result.executed, 0);
});
test("e2e: failed verification retains evidence, performs bounded rework and never ships", async () => {
  const h = harness({ policy: { max_rework_attempts: 1 }, verification: [{ id: "feature", command: [process.execPath, "-e", "console.error('expected failure');process.exit(1)"] }] });
  h.submit("bad verification");
  const result = await h.engine.run();
  const job = Object.values(result.jobs)[0];
  assert.equal(job.state, "Blocked");
  assert.equal(job.attempts.length, 2);
  assert.match(job.attempts[0].verification.checks[0].stderr, /expected failure/);
  assert.equal(job.shipping, undefined);
  assert.equal(result.projects.example.blocked, true);
  assert.equal(git(h.remote, ["show-ref", "--heads"]).split("\n").length, 1);
});
test("e2e: bounded repair can fix failed verification and then ship", async () => {
  const h = harness(); h.submit("repair this change");
  const result = await h.engine.run();
  const job = Object.values(result.jobs)[0];
  assert.equal(job.state, "Shipped");
  assert.equal(job.attempts.length, 2);
  assert.equal(job.attempts[0].verification.passed, false);
  assert.equal(job.attempts[1].verification.passed, true);
});
test("e2e: human approval stops execution; current-revision approval resumes", async () => {
  const h = harness(); const item = h.submit("requires approval");
  let result = await h.engine.run();
  assert.equal(result.items[item.id].state, "Review");
  assert.equal(result.items[item.id].questions.length, 1);
  assert.equal(result.items[item.id].questions[0].status, "open");
  assert.equal(result.executed, 0);
  assert.throws(() => h.engine.approve(item.id, 1, "human"), /revision/);
  h.engine.approve(item.id, result.items[item.id].revision, "human");
  result = await h.engine.run();
  assert.equal(result.items[item.id].questions[0].status, "answered");
  assert.equal(Object.values(result.jobs)[0].state, "Shipped");
});
test("e2e: continue-project ships two jobs exactly once, chains their output and stops", async () => {
  const h = harness(); h.submit("first"); h.submit("second");
  const result = await h.engine.run();
  const jobs = Object.values(result.jobs);
  assert.equal(result.executed, 2);
  assert.ok(jobs.every((j) => j.state === "Shipped" && j.attempts.length === 1));
  const contents = git(h.remote, ["show", `${jobs[1].shipping.commit}:feature.txt`]);
  assert.match(contents, /first/); assert.match(contents, /second/);
  assert.equal((await h.engine.run()).executed, 0);
});
test("e2e: stop-after-job leaves the second ready job untouched", async () => {
  const h = harness({ policy: { continuation: "stop_after_job" } }); h.submit("first"); h.submit("second");
  const result = await h.engine.run();
  assert.equal(result.executed, 1);
  assert.deepEqual(Object.values(result.jobs).map((j) => j.state), ["Shipped", "Ready"]);
  assert.equal(Object.values(result.jobs)[1].attempts.length, 0);
});

test("integration: dispatch preserves project order and skips an ineligible head for independent work", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-dispatch-heads-"));
  const store = new Store(directory);
  const projects = [schedulingProject("alpha"), schedulingProject("beta")];
  store.change((data) => {
    data.projects.alpha = {};
    data.projects.beta = {};
    data.jobs["alpha-head"] = schedulingJob("alpha-head", "alpha", 0, { dependencies: ["blocked-dependency"] });
    data.jobs["alpha-later"] = schedulingJob("alpha-later", "alpha", 1, { priority: 0 });
    data.jobs["blocked-dependency"] = schedulingJob("blocked-dependency", "external", 0, { state: "Blocked" });
    data.jobs["beta-head"] = schedulingJob("beta-head", "beta", 2);
  });
  const selected = [];

  const result = await schedulingEngine(store, projects, selected).runDispatch();

  assert.equal(result.executed, 1);
  assert.deepEqual(selected, ["beta-head"]);
  assert.equal(result.jobs["alpha-head"].state, "Ready");
  assert.equal(result.jobs["alpha-later"].state, "Ready");
});

test("integration: persisted weighted fairness survives bounded worker invocations", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-dispatch-fairness-"));
  const projects = [schedulingProject("alpha", 3), schedulingProject("beta", 1)];
  const store = new Store(directory);
  store.change((data) => {
    data.projects.alpha = {};
    data.projects.beta = {};
    for (let index = 0; index < 8; index++) {
      data.jobs[`alpha-${index}`] = schedulingJob(`alpha-${index}`, "alpha", index * 2);
      data.jobs[`beta-${index}`] = schedulingJob(`beta-${index}`, "beta", index * 2 + 1);
    }
  });
  const selected = [];

  for (let invocation = 0; invocation < 8; invocation++) {
    const restarted = new Store(directory);
    await schedulingEngine(restarted, projects, selected).runDispatch();
  }

  assert.deepEqual(selected, ["alpha-0", "beta-0", "alpha-1", "alpha-2", "alpha-3", "beta-1", "alpha-4", "alpha-5"]);
  const scheduler = new Store(directory).read().system_metadata.execution_scheduler;
  assert.equal(scheduler.projects.alpha.allocations, 6);
  assert.equal(scheduler.projects.beta.allocations, 2);
});

test("integration: an existing running slice is never preempted", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-dispatch-running-"));
  const store = new Store(directory);
  store.change((data) => {
    data.projects.alpha = { active: true };
    data.projects.beta = {};
    data.jobs.running = schedulingJob("running", "alpha", 0, { state: "Executing" });
    data.jobs.independent = schedulingJob("independent", "beta", 1);
  });
  const selected = [];

  await assert.rejects(() => schedulingEngine(store, [schedulingProject("alpha"), schedulingProject("beta")], selected).runDispatch(), /recovery/);
  const state = store.read();
  assert.deepEqual(selected, []);
  assert.equal(state.jobs.running.state, "Executing");
  assert.equal(state.jobs.independent.state, "Ready");
});
test("e2e: decomposed work executes sequentially with dependency links", async () => {
  const h = harness(); h.submit("decompose this request");
  const result = await h.engine.run();
  const jobs = Object.values(result.jobs);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[1].dependencies, [jobs[0].id]);
  assert.ok(jobs.every((j) => j.state === "Shipped"));
});
test("e2e: clarification preserves original request and re-decides with human context", async () => {
  const h = harness(); const item = h.submit("ambiguous idea");
  await h.engine.run();
  h.engine.clarify(item.id, "Append a feature entry", "human", "example");
  const result = await h.engine.run();
  assert.equal(result.items[item.id].input.text, "ambiguous idea");
  assert.equal(result.items[item.id].clarifications.length, 1);
  assert.equal(statusView(result).items[0].state, "Shipped");
});
test("e2e: commit-only policy verifies but does not push", async () => {
  const h = harness({ policy: { shipping: "commit_only" } }); h.submit("local only");
  const job = Object.values((await h.engine.run()).jobs)[0];
  assert.equal(job.state, "Shipped"); assert.equal(job.shipping.pushed, false);
  assert.equal(git(h.remote, ["show-ref", "--heads"]).split("\n").length, 1);
});
test("integration: a second worker cannot claim or delete the first worker's lease", async () => {
  const h = harness(); h.submit("slow change");
  const first = h.engine.run();
  await assert.rejects(() => new Engine({ store: h.store, config: h.config }).run(), /Locked/);
  assert.ok(fs.existsSync(h.store.triageLock) || fs.existsSync(h.store.workerLock));
  assert.equal((await first).executed, 1);
});
test("integration: verification changing the committed version cannot ship", async () => {
  const h = harness({ policy: { max_rework_attempts: 0 }, verification: [{ id: "feature", command: [process.execPath, "-e", "require('fs').appendFileSync('feature.txt','untested mutation')"] }] });
  h.submit("change");
  const job = Object.values((await h.engine.run()).jobs)[0];
  assert.equal(job.state, "Blocked");
  assert.equal(job.attempts[0].verification.passed, false);
  assert.equal(job.shipping, undefined);
});
test("integration: unsupported delivery policy blocks before executor invocation", async () => {
  const h = harness({ policy: { shipping: "create_pull_request" } }); h.submit("change");
  const job = Object.values((await h.engine.run()).jobs)[0];
  assert.equal(job.state, "Blocked"); assert.equal(job.attempts.length, 0);
});

test("e2e: autonomous fixture deployment verifies and reaches durable Shipped state", async () => {
  const h = harness({ policy: { shipping: "deploy" }, deployment: { kind: "fixture", environment: "production" } });
  const item = h.submit("deploy this safely");
  const result = await h.engine.run();
  const job = Object.values(result.jobs)[0];
  assert.equal(job.state, "Shipped");
  assert.equal(result.items[item.id].state, "Ready");
  assert.equal(job.shipping.pushed, false);
  assert.equal(job.shipping.deployment.provider, "fixture");
  assert.equal(job.shipping.deployment.environment, "production");
  assert.equal(job.shipping.deployment.status, "succeeded");
  const restarted = new Store(h.store.directory).read();
  assert.equal(restarted.jobs[job.id].state, "Shipped");
  assert.equal(restarted.jobs[job.id].shipping.deployment.revision, job.shipping.commit);
});

test("e2e: configured command deployment provider receives verified commit and ships", async () => {
  const h = harness({
    policy: { shipping: "deploy" },
    deployment: { kind: "command", environment: "preview", command: [process.execPath, provider, "deploy"] },
  });
  h.submit("deploy through command provider");
  const job = Object.values((await h.engine.run()).jobs)[0];
  assert.equal(job.state, "Shipped");
  assert.equal(job.shipping.deployment.provider, "command");
  assert.equal(job.shipping.deployment.environment, "preview");
  assert.equal(job.shipping.deployment.revision, job.shipping.commit);
  assert.match(job.shipping.deployment.url, new RegExp(job.shipping.commit));
});
test("integration: dirty source repository is preserved and blocks work", async () => {
  const h = harness(); fs.writeFileSync(path.join(h.repository, "personal.txt"), "preserve me"); h.submit("change");
  const job = Object.values((await h.engine.run()).jobs)[0];
  assert.equal(job.state, "Blocked");
  assert.equal(fs.readFileSync(path.join(h.repository, "personal.txt"), "utf8"), "preserve me");
});
test("e2e CLI: separate submit, run, and status processes complete the delivery", () => {
  const h = harness();
  const cli = path.resolve("src/cli.js");
  const invoke = (args) => {
    const result = spawnSync(process.execPath, [cli, "depot", ...args, "--state-dir", h.store.directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  invoke(["submit", "--text", "CLI idea", "--project", "example", "--key", "cli-first"]);
  assert.equal(invoke(["run", "--config", h.configFile]).executed, 1);
  assert.equal(invoke(["status"]).items[0].state, "Shipped");
});

test("integration: push failure blocks without repeating execution or marking Shipped", async () => {
  const h = harness();
  git(h.repository, ["remote", "set-url", "origin", path.join(h.root, "missing.git")]);
  h.submit("change");
  const result = await h.engine.run();
  const job = Object.values(result.jobs)[0];
  assert.equal(job.state, "Blocked");
  assert.equal(job.attempts.length, 1);
  assert.ok(job.delivery_intent.commit);
  assert.equal(job.shipping, undefined);
  assert.equal((await h.engine.run()).executed, 0);
});

test("integration: crash-like persistence failure after a successful push never retries execution", async () => {
  const h = harness(); h.submit("delivery persistence failure");
  class InterruptedDelivery extends GitDelivery {
    async ship(args) {
      const result = await super.ship(args);
      const change = h.store.change.bind(h.store);
      h.store.change = (...call) => {
        h.store.change = change;
        throw new Error("simulated disk failure after push");
      };
      return result;
    }
  }
  const engine = new Engine({ store: h.store, config: h.config, shipping: new InterruptedDelivery() });
  const job = Object.values((await engine.run()).jobs)[0];
  assert.equal(job.state, "Blocked");
  assert.equal(job.attempts.length, 1);
  assert.equal(git(h.remote, ["rev-parse", job.delivery_intent.branch]), job.delivery_intent.commit);
  assert.equal((await engine.run()).executed, 0);
});

test("integration: post-shipping human gate pauses queue without relabeling shipped work Review", async () => {
  const h = harness({ policy: { review_after_shipping: true } }); h.submit("first"); h.submit("second");
  const result = await h.engine.run();
  assert.equal(result.executed, 1);
  assert.deepEqual(Object.values(result.jobs).map((j) => j.state), ["Shipped", "Ready"]);
  assert.equal(result.projects.example.review_required, true);
  assert.equal((await h.engine.run()).executed, 0);
});

test("integration: configured job bound and explicit stop prevent blind continuation", async () => {
  const h = harness(); h.config.max_jobs_per_run = 1; h.submit("first"); h.submit("second");
  const result = await h.engine.run();
  assert.equal(result.executed, 1); assert.equal(result.limit_reached, true);
  h.store.change((data) => { data.projects.example.stop = true; });
  assert.equal((await h.engine.run()).executed, 0);
  assert.equal(Object.values(h.store.read().jobs)[1].state, "Ready");
});

test("integration: changed policy cannot reuse an old approval", async () => {
  const h = harness(); const item = h.submit("requires approval");
  await h.engine.run();
  const revision = h.store.read().items[item.id].revision;
  h.config.projects[0].policy.shipping = "commit_only";
  assert.throws(() => h.engine.approve(item.id, revision, "human"), /changed/);
});

test("integration: executor failure respects zero rework budget", async () => {
  const h = harness({ policy: { max_rework_attempts: 0 } }); h.submit("executor fails");
  const job = Object.values((await h.engine.run()).jobs)[0];
  assert.equal(job.state, "Blocked"); assert.equal(job.attempts.length, 1);
  assert.equal(job.attempts[0].execution.exit_code, 7);
  assert.equal(job.shipping, undefined);
});

test("e2e: independent CLI worker is excluded, crash recovery blocks interrupted work without replay", async () => {
  const h = harness(); h.submit("slow change");
  const cli = path.resolve("src/cli.js");
  const args = [cli, "depot", "run", "--state-dir", h.store.directory, "--config", h.configFile];
  const child = spawn(process.execPath, args, { stdio: "ignore" });
  const exited = once(child, "exit");
  let executing;
  for (let i = 0; i < 150; i++) {
    executing = Object.values(h.store.read().jobs).find((job) => job.state === "Executing" && job.processes.length);
    if (executing) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!executing) { child.kill("SIGKILL"); await exited; assert.fail("Worker did not reach execution."); }
  const other = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(other.status, 0); assert.match(other.stderr, /Locked/);
  child.kill("SIGKILL"); await exited;
  assert.throws(() => h.store.recover(), /child process/);
  await new Promise((resolve) => setTimeout(resolve, 1900));
  const recovered = h.store.recover();
  assert.equal(recovered.jobs[executing.id].state, "Blocked");
  assert.equal(recovered.projects.example.blocked, true);
  assert.equal((await h.engine.run()).executed, 0);
  assert.equal(h.store.read().jobs[executing.id].attempts.length, 1);
});
