import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { harness } from "./support/harness.js";
import { git } from "../src/workflow/delivery.js";
import { diagnoseBlocker } from "../src/workflow/unblocker.js";
import { WorkerLoop } from "../src/server/worker.js";

function codexHarness() {
  const h = harness({ executor: { kind: "codex", bin: "codex" }, policy: { max_rework_attempts: 0 } });
  h.engine.runtime = { execute: async ({ workspace, job }) => {
    fs.appendFileSync(path.join(workspace, "feature.txt"), "implemented: " + job.work.title + "\n");
    return { passed: true, exit_code: 0, stdout: "", stderr: "" };
  } };
  return h;
}
async function readyJobs(h, titles) {
  const submitted = titles.map(title => h.submit(title, title));
  for (let i = 0; i < titles.length; i++) await h.engine.runTriage();
  const data = h.store.read();
  return submitted.map(item => data.jobs[data.items[item.id].job_ids[0]]);
}
function markIsolatedFailure(h, jobId) {
  h.store.change(data => {
    const job = data.jobs[jobId];
    job.attempts = [{ number: 1, execution: { passed: true, exit_code: 0 },
      verification: { passed: false, checks: [{ id: "feature", passed: false }] } }];
    h.store.move(data, job, "Blocked", "Rework limit reached: Required verification failed.");
    data.projects.example = { ...(data.projects.example ?? {}), blocked: true, active: false };
  });
}

test("Unblocker releases unrelated Ready work but never retries a failed job or its dependents", async () => {
  const h = codexHarness();
  const [failed, independent, dependent] = await readyJobs(h, ["isolated failed slice", "independent verified slice", "dependent slice"]);
  h.store.change(data => { data.jobs[dependent.id].dependencies = [failed.id]; });
  markIsolatedFailure(h, failed.id);
  const result = await h.engine.runUnblocker();
  assert.deepEqual(result.released_projects, ["example"]);
  assert.equal(result.isolated_jobs, 1);
  const isolated = h.store.read();
  assert.equal(isolated.projects.example.blocked, false);
  assert.equal(isolated.jobs[failed.id].state, "Blocked");
  assert.equal(isolated.jobs[failed.id].attempts.length, 1);
  assert.equal(isolated.jobs[dependent.id].state, "Ready");
  assert.deepEqual(isolated.jobs[dependent.id].dependencies, [failed.id]);
  const dispatched = await h.engine.runDispatch();
  assert.equal(dispatched.jobs[independent.id].state, "Shipped");
  assert.equal(dispatched.jobs[dependent.id].state, "Ready");
  assert.equal(dispatched.jobs[failed.id].state, "Blocked");
  assert.equal(dispatched.jobs[independent.id].attempts.length, 1);
  assert.equal(git(h.remote, ["rev-parse", dispatched.jobs[independent.id].shipping.branch]), dispatched.jobs[independent.id].shipping.commit);
  const again = await h.engine.runUnblocker();
  assert.deepEqual(again.released_projects, []);
});

test("Unblocker refreshes harmless project context drift through the existing authority guard", async () => {
  const h = codexHarness();
  const [job] = await readyJobs(h, ["ordinary context update"]);
  fs.appendFileSync(path.join(h.repository, "README.md"), "Additional context, no authority change\n");
  git(h.repository, ["add", "README.md"]);
  git(h.repository, ["commit", "-m", "Refresh project documentation"]);
  git(h.repository, ["push", "origin", "main"]);
  h.store.change(data => {
    h.store.move(data, data.jobs[job.id], "Blocked", "Project policy or context changed after decision; resubmit for a new decision.");
    data.projects.example = { ...data.projects.example, blocked: true, active: false };
  });
  const result = await h.engine.runUnblocker();
  assert.equal(result.refreshed, 1);
  assert.equal(h.store.read().jobs[job.id].state, "Ready");
  assert.equal(h.store.read().jobs[job.id].context_refresh.actor, "roundhouse-unblocker");
  assert.equal(h.store.read().projects.example.blocked, false);
});

test("Unblocker retains operator stop and unknown remote/external outcome quarantine", async () => {
  const h = codexHarness();
  const [job] = await readyJobs(h, ["remote uncertain change"]);
  markIsolatedFailure(h, job.id);
  h.store.change(data => { data.jobs[job.id].attempts[0].execution.remote_execution = { machine_selector: "iMac" }; });
  const uncertain = await h.engine.runUnblocker();
  assert.deepEqual(uncertain.released_projects, []);
  assert.equal(uncertain.needs_attention, 1);
  assert.equal(h.store.read().projects.example.blocked, true);
  h.store.change(data => {
    delete data.jobs[job.id].attempts[0].execution.remote_execution;
    data.projects.example.stop = true;
  });
  assert.deepEqual((await h.engine.runUnblocker()).released_projects, []);
  assert.equal(h.store.read().projects.example.stop, true);
  assert.equal(h.store.read().projects.example.blocked, true);
  h.store.change(data => { data.projects.example.stop = false;data.projects.example.review_required = true; });
  assert.deepEqual((await h.engine.runUnblocker()).released_projects, []);
  assert.equal(h.store.read().projects.example.review_required, true);
});

test("Unblocker never erases an unknown project-wide hold or changes a failed command executor", async () => {
  const h = harness();
  const [job] = await readyJobs(h, ["command executor failure"]);
  markIsolatedFailure(h, job.id);
  assert.equal(diagnoseBlocker(h.store.read().jobs[job.id], h.config.projects[0]).action, "human_review");
  assert.deepEqual((await h.engine.runUnblocker()).released_projects, []);
  h.store.change(data => { data.jobs[job.id].state = "Shipped"; });
  assert.deepEqual((await h.engine.runUnblocker()).released_projects, []);
  assert.equal(h.store.read().projects.example.blocked, true);
});

test("event-driven worker calls Unblocker before triage and dispatch without adding polling", async () => {
  const order = [];
  const engine = {
    runUnblocker: async () => { order.push("unblock"); return { released_projects: ["example"], refreshed: 0, isolated_jobs: 1, needs_attention: 0 }; },
    runTriage: async () => { order.push("triage"); return { triaged: 0 }; },
    runDispatch: async () => { order.push("dispatch"); return { executed: 0 }; },
  };
  const worker = new WorkerLoop({ service: { engine, store: { shared: false } } });
  await worker.tick();
  assert.deepEqual(order, ["unblock", "triage", "dispatch"]);
  assert.equal(worker.status().unblocker_result.released_projects[0], "example");
  await worker.stop();
});

test("an unrelated uncertain blocker prevents a safe context refresh from clearing quarantine", async () => {
  const h = codexHarness();
  const [stale, uncertain] = await readyJobs(h, ["stale harmless context", "uncertain remote outcome"]);
  h.store.change(data => {
    h.store.move(data, data.jobs[stale.id], "Blocked", "Project policy or context changed after decision; resubmit for a new decision.");
    const blocked = data.jobs[uncertain.id];
    blocked.attempts = [{ number: 1, execution: { remote_execution: { machine_selector: "iMac" } } }];
    h.store.move(data, blocked, "Blocked", "Machine-local Herdr outcome requires explicit reconciliation and will not be replayed automatically.");
    data.projects.example = { ...data.projects.example, blocked: true };
  });
  const report = await h.engine.runUnblocker();
  assert.equal(report.refreshed, 0);
  assert.deepEqual(report.released_projects, []);
  assert.equal(h.store.read().jobs[stale.id].state, "Blocked");
  assert.equal(h.store.read().projects.example.blocked, true);
});

test("changed execution authority is never accepted as harmless context refresh", async () => {
  const h = codexHarness();
  const [job] = await readyJobs(h, ["authority change"]);
  h.store.change(data => {
    h.store.move(data, data.jobs[job.id], "Blocked", "Project policy or context changed after decision; resubmit for a new decision.");
    data.projects.example = { ...data.projects.example, blocked: true };
  });
  h.config.projects[0].policy.shipping = "commit_only";
  const result = await h.engine.runUnblocker();
  assert.equal(result.refreshed, 0);
  assert.deepEqual(result.released_projects, []);
  assert.equal(h.store.read().jobs[job.id].state, "Blocked");
  assert.equal(h.store.read().projects.example.blocked, true);
});

test("Unblocker can be invoked by the existing scheduled dispatcher without a model request", () => {
  const h = codexHarness();
  const response = spawnSync(process.execPath, [
    new URL("../src/cli.js", import.meta.url).pathname,
    "depot", "unblock",
    "--state-dir", h.store.directory,
    "--config", h.configFile,
  ], { encoding: "utf8", timeout: 15_000 });
  assert.equal(response.status, 0, response.stderr);
  const result = JSON.parse(response.stdout);
  assert.equal(result.role, "Unblocker");
  assert.deepEqual(result.released_projects, []);
  assert.equal(result.refreshed, 0);
});
