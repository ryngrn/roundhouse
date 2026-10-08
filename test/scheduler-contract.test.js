import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateWorkflowConfig } from "../src/workflow/config.js";
import { Store } from "../src/workflow/store.js";
import { compareDispatchCandidates, dispatchConsiderations, eligibleProjectHead, executionReservation, projectExecutionEligible, projectQueueHead, recordAllocation, recordDispatchRound, reservationAssessment, reservationFits, schedulerState, weightedAllocation } from "../src/workflow/scheduler.js";
import { statusView } from "../src/workflow/views.js";

function manifest(repository, changes = {}) {
  return {
    projects: [{
      id: "example", name: "Example", purpose: "Test contracts", success_state: "Checks pass", status: "active",
      repository, verification: [{ id: "tests", command: ["npm", "test"] }], ...changes,
    }],
  };
}

test("scheduler contract: execution capacity defaults to one without changing single-slot projects", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-capacity-"));
  const config = validateWorkflowConfig(manifest(directory), path.join(directory, "config.yaml"));
  assert.deepEqual(config.execution, { capacity: 1, capabilities: [], resource_limits: {} });
  assert.equal(config.projects[0].max_concurrent_runs, 1);
  assert.deepEqual(config.projects[0].required_capabilities, []);
  assert.deepEqual(config.projects[0].resource_requirements, {});
  assert.equal(projectExecutionEligible(config.projects[0], config.execution), true);
});

test("scheduler contract: invalid capacity, capability, project limit, and resources are rejected", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-contract-validation-"));
  const filename = path.join(directory, "config.yaml");
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory), execution: { capacity: 0 } }, filename), /execution.capacity/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory), execution: { capacity: 2, capabilities: ["GPU"] } }, filename), /stable lowercase/);
  assert.throws(() => validateWorkflowConfig(manifest(directory, { max_concurrent_runs: 2 }), filename), /global execution capacity/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory, { required_capabilities: ["gpu"] }), execution: { capabilities: [] } }, filename), /undeclared execution capability/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory), execution: { resource_limits: { gpu: 0 } } }, filename), /positive integer/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory, { resource_requirements: { gpu: 2 } }), execution: { resource_limits: { gpu: 1 } } }, filename), /more gpu/);
});

test("scheduler contract: weighted allocation state is durable across store reconstruction", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-scheduler-state-"));
  const store = new Store(directory);
  store.change((data) => {
    data.projects.alpha = { turns: 2 };
    const scheduler = schedulerState(data, 3);
    assert.equal(weightedAllocation(scheduler, { id: "alpha", weight: 2 }), 1);
    recordAllocation(data, { id: "alpha", weight: 2 }, 3, "2026-01-01T00:00:00.000Z");
  });

  const scheduler = new Store(directory).read().system_metadata.execution_scheduler;
  assert.equal(scheduler.version, 2);
  assert.equal(scheduler.capacity, 3);
  assert.equal(scheduler.sequence, 1);
  assert.deepEqual(scheduler.projects.alpha, {
    allocations: 3,
    last_selected_sequence: 1,
    last_selected_at: "2026-01-01T00:00:00.000Z",
  });
});

test("scheduler contract: allocation explanations persist every eligibility and constraint fact across restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-scheduler-evidence-"));
  const store = new Store(directory);
  const execution = { capacity: 2, capabilities: ["cpu"], resource_limits: { browser: 1 } };
  const projects = [
    { id: "alpha", status: "active", weight: 3, max_concurrent_runs: 1, required_capabilities: ["cpu"], resource_requirements: { browser: 1 }, repository: "/repo/shared", policy: { shipping: "push_branch" } },
    { id: "beta", status: "active", weight: 1, max_concurrent_runs: 1, required_capabilities: ["cpu"], resource_requirements: {}, repository: "/repo/beta", policy: { shipping: "commit_only" } },
  ];
  store.change((data) => {
    data.projects.alpha = {};
    data.projects.beta = {};
    data.items.a = { id: "a", project_id: "alpha", state: "Ready", input: { text: "Alpha" }, questions: [], history: [], job_ids: ["alpha-job"] };
    data.items.b = { id: "b", project_id: "beta", state: "Ready", input: { text: "Beta" }, questions: [], history: [], job_ids: ["beta-job"] };
    data.jobs["alpha-job"] = { id: "alpha-job", parent_id: "a", project_id: "alpha", position: 0, state: "Ready", dependencies: [], attempts: [], history: [], work: { title: "Alpha slice" } };
    data.jobs["beta-job"] = { id: "beta-job", parent_id: "b", project_id: "beta", position: 0, state: "Ready", dependencies: [], attempts: [], history: [], work: { title: "Beta slice" } };
    const considerations = dispatchConsiderations(data, projects, execution);
    recordDispatchRound(data, considerations, "alpha-job", execution.capacity, "2026-01-01T00:00:00.000Z");
  });

  const restarted = new Store(directory);
  const view = statusView(restarted.read());
  assert.equal(view.allocations.decisions.length, 2);
  assert.deepEqual(view.allocations.decisions.map((decision) => decision.result), ["allocated", "deferred"]);
  const alpha = view.allocations.latest.alpha;
  assert.equal(alpha.eligible, true);
  assert.deepEqual(alpha.queue, { position: 1, length: 1, slice_position: 0 });
  assert.deepEqual(alpha.fairness, { weight: 3, allocations_before: 0, weighted_allocation: 0, rank: 1, recovery_precedence: false });
  assert.deepEqual(alpha.constraints.capability, { required: ["cpu"], available: ["cpu"], missing: [], fits: true });
  assert.equal(alpha.constraints.capacity.limit, 2);
  assert.equal(alpha.constraints.resources[0].resource, "browser");
  assert.match(view.allocations.latest.beta.reason.message, /weighted allocation/);
  assert.equal(view.items[0].jobs[0].allocation.job_id, "alpha-job");
});

test("scheduler contract: fresh recovery takes precedence over ordinary fairness", () => {
  const ordinary = { project: { id: "alpha" }, job: { id: "ordinary" }, fairness: { weighted_allocation: 0 } };
  const recovery = { project: { id: "beta" }, job: { id: "repair", recovery_for: "blocked-job" }, fairness: { weighted_allocation: 9 } };
  assert.deepEqual([ordinary, recovery].sort(compareDispatchCandidates).map((entry) => entry.job.id), ["repair", "ordinary"]);
});

test("scheduler contract: an isolated blocked prerequisite does not hide independent Ready work", () => {
  const data = { jobs: {
    later: { id: "later", project_id: "alpha", state: "Ready", position: 2, priority_rank: 0, dependencies: [] },
    head: { id: "head", project_id: "alpha", state: "Ready", position: 1, priority_rank: 100, dependencies: ["dependency"] },
    dependency: { id: "dependency", project_id: "other", state: "Blocked", position: 0, dependencies: [] },
  } };

  assert.equal(projectQueueHead(data, "alpha").id, "head");
  assert.equal(eligibleProjectHead(data, "alpha").id, "later");
  data.jobs.dependency.state = "Shipped";
  assert.equal(eligibleProjectHead(data, "alpha").id, "head");
  data.jobs.head.state = "Executing";
  assert.equal(eligibleProjectHead(data, "alpha").id, "later");
});

test("scheduler contract: reservations enforce capabilities, capacity, project limits, resources, and locks together", () => {
  const execution = { capacity: 3, capabilities: ["cpu", "gpu"], resource_limits: { gpu: 2, browser: 1 } };
  const alpha = executionReservation({
    id: "alpha", repository: "/repos/alpha", remote: "origin", max_concurrent_runs: 2,
    required_capabilities: ["gpu"], resource_requirements: { gpu: 1 }, policy: { shipping: "push_branch" },
  });
  const beta = executionReservation({
    id: "beta", repository: "/repos/beta", remote: "origin", max_concurrent_runs: 1,
    required_capabilities: ["cpu"], resource_requirements: { browser: 1 }, policy: { shipping: "commit_only" },
  });
  assert.equal(reservationFits([], alpha, execution), true);
  assert.equal(reservationFits([alpha], beta, execution), true);
  assert.equal(reservationFits([alpha], { ...alpha, locks: ["repository:/repos/other"] }, execution), true);
  assert.equal(reservationFits([alpha, alpha], { ...alpha, locks: ["repository:/repos/other"] }, execution), false);
  assert.equal(reservationFits([beta], { ...beta, project_id: "gamma", locks: ["repository:/repos/gamma"] }, execution), false);
  assert.equal(reservationFits([], { ...alpha, required_capabilities: ["tpu"] }, execution), false);
  assert.equal(reservationFits([alpha], { ...beta, locks: alpha.locks }, execution), false);
  assert.equal(reservationFits([alpha, beta], { ...beta, project_id: "gamma", capacity_units: 2, locks: ["repository:/repos/gamma"], resources: {} }, execution), false);
  const blocked = reservationAssessment([alpha], { ...beta, locks: alpha.locks }, execution);
  assert.equal(blocked.fits, false);
  assert.deepEqual(blocked.constraints.locks.conflicts, alpha.locks);
});
