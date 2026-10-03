import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateWorkflowConfig } from "../src/workflow/config.js";
import { Store } from "../src/workflow/store.js";
import { eligibleProjectHead, projectExecutionEligible, projectQueueHead, recordAllocation, schedulerState, weightedAllocation } from "../src/workflow/scheduler.js";

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
  assert.equal(scheduler.version, 1);
  assert.equal(scheduler.capacity, 3);
  assert.equal(scheduler.sequence, 1);
  assert.deepEqual(scheduler.projects.alpha, {
    allocations: 3,
    last_selected_sequence: 1,
    last_selected_at: "2026-01-01T00:00:00.000Z",
  });
});

test("scheduler contract: only the earliest unfinished project slice can be eligible", () => {
  const data = { jobs: {
    later: { id: "later", project_id: "alpha", state: "Ready", position: 2, priority_rank: 0, dependencies: [] },
    head: { id: "head", project_id: "alpha", state: "Ready", position: 1, priority_rank: 100, dependencies: ["dependency"] },
    dependency: { id: "dependency", project_id: "other", state: "Blocked", position: 0, dependencies: [] },
  } };

  assert.equal(projectQueueHead(data, "alpha").id, "head");
  assert.equal(eligibleProjectHead(data, "alpha"), null);
  data.jobs.dependency.state = "Shipped";
  assert.equal(eligibleProjectHead(data, "alpha").id, "head");
  data.jobs.head.state = "Executing";
  assert.equal(eligibleProjectHead(data, "alpha"), null);
});
