import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateWorkflowConfig } from "../src/workflow/config.js";
import { Store } from "../src/workflow/store.js";
import { dispatchConsiderations, eligibleProjectHead, executionEligibility, executionReservation, projectExecutionEligible, projectQueueHead, recordAllocation, recordDispatchRound, reservationAssessment, reservationFits, schedulerState, weightedAllocation } from "../src/workflow/scheduler.js";
import { statusView } from "../src/workflow/views.js";
import { CapabilityRuntime, ExecutionAdapterRegistry, executionProviderEvidence, selectExecutionProvider } from "../src/workflow/execution-adapters.js";
import { REMOTE_DESKTOP_COMMANDER_PERMITTED_USES, isRemoteDesktopCommanderCommand } from "../src/workflow/remote-desktop-policy.js";

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
  assert.deepEqual(config.execution, { capacity: 1, capabilities: [], resource_limits: {},
    providers: [{ id: "local-project", kind: "project", capabilities: [] }] });
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
  const unavailable = validateWorkflowConfig({ ...manifest(directory, { required_capabilities: ["gpu"] }), execution: { capabilities: [] } }, filename);
  assert.deepEqual(unavailable.projects[0].required_capabilities, ["gpu"]);
  assert.equal(projectExecutionEligible(unavailable.projects[0], unavailable.execution), false);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory), execution: { resource_limits: { gpu: 0 } } }, filename), /positive integer/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory, { resource_requirements: { gpu: 2 } }), execution: { resource_limits: { gpu: 1 } } }, filename), /more gpu/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory), execution: { capabilities: ["research"], providers: [
    { id: "research", kind: "command", capabilities: ["external-action"], command: ["provider"] },
  ] } }, filename), /unavailable on this installation/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory), execution: { providers: [
    { id: "duplicate", kind: "project", capabilities: [] }, { id: "duplicate", kind: "command", capabilities: [], command: ["provider"] },
  ] } }, filename), /ids must be unique/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory), execution: { providers: [
    { id: "bad-probe", kind: "command", capabilities: [], command: ["provider"], probe: [] },
  ] } }, filename), /probe must be an argv array/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory), execution: { providers: [
    { id: "project-probe", kind: "project", capabilities: [], probe: ["provider", "probe"] },
  ] } }, filename), /cannot define a probe command/);
});

test("execution providers: registration and selection depend only on complete capability fit", () => {
  const execute = async () => ({ passed: true });
  const registry = new ExecutionAdapterRegistry([
    { id: "wide", capabilities: ["research", "connected-source", "scheduling", "artifact", "human-task"], execute },
    { id: "zeta", capabilities: ["research", "artifact"], execute },
    { id: "alpha", capabilities: ["research", "artifact"], execute },
    { id: "scheduling", capabilities: ["scheduling"], execute },
  ]);
  assert.equal(registry.select(["research", "artifact"]).id, "alpha");
  assert.equal(registry.select(["research", "scheduling"]).id, "wide");
  assert.equal(registry.select(["research", "human-task"]).id, "wide");
  assert.equal(registry.select(["connected-source", "artifact"]).id, "wide");
  assert.equal(registry.select(["research", "unknown"]), null);
  assert.throws(() => registry.require(["research", "unknown"]), /research, unknown/);
  assert.throws(() => registry.register({ id: "alpha", capabilities: [], execute }), /Duplicate/);
});

test("execution providers: cheapest-sufficient routing is deterministic and explains escalation", () => {
  const providers = [
    { id: "tier-0-mechanical", kind: "command", capabilities: [], tier: 0, max_risk: "read_only", min_confidence: 0.95, context_window: 2_000, latency_ms: 25 },
    { id: "tier-1-local", kind: "project", capabilities: ["research"], tier: 1, max_risk: "consequential", min_confidence: 0.75, context_window: 20_000, latency_ms: 500 },
    { id: "tier-2-paid", kind: "command", capabilities: ["research", "artifact"], tier: 2, max_risk: "human_task", min_confidence: 0, context_window: 200_000, latency_ms: 2_000 },
  ];
  const mechanical = { risk: "read_only", confidence: 0.99, context_bytes: 800, max_latency_ms: 100 };
  assert.equal(selectExecutionProvider(providers, [], { requirements: mechanical }).id, "tier-0-mechanical");

  const local = { risk: "consequential", confidence: 0.9, context_bytes: 8_000, max_latency_ms: 1_000 };
  assert.equal(selectExecutionProvider(providers, ["research"], { requirements: local }).id, "tier-1-local");
  const localEvidence = executionProviderEvidence(providers, ["research"], { requirements: local });
  assert.equal(localEvidence.routing.selection.escalated, true);
  assert.deepEqual(localEvidence.routing.results[0].gaps.capability, ["research"]);

  const uncertain = { risk: "consequential", confidence: 0.6, context_bytes: 8_000, max_latency_ms: 3_000 };
  const paidEvidence = executionProviderEvidence(providers, ["research"], { requirements: uncertain });
  assert.equal(paidEvidence.selected.id, "tier-2-paid");
  assert.deepEqual(paidEvidence.routing.results[1].gaps.confidence, { required: 0.6, minimum: 0.75 });
  assert.equal(paidEvidence.routing.selection.escalated, true);

  const explicit = new CapabilityRuntime(providers.map((provider) => ({ ...provider,
    command: provider.kind === "command" ? [process.execPath, "-e", ""] : undefined })), { execute: async () => ({ passed: true }) });
  assert.equal(explicit.registry.get("tier-1-local", ["research"]).id, "tier-1-local", "explicit provider pins remain authoritative");
});

test("execution providers: offline and degraded nodes do not prevent another sufficient node from serving tier 1 or tier 2 work", () => {
  const providers = [
    { id: "offline-studio", capabilities: ["research"], tier: 1, available: false, node_id: "studio" },
    { id: "degraded-laptop", capabilities: ["research", "artifact"], current_capabilities: ["research"], tier: 1, node_id: "laptop" },
    { id: "online-desktop", capabilities: ["research", "artifact"], tier: 2, available: true, node_id: "desktop" },
  ];
  assert.equal(selectExecutionProvider(providers, ["research"]).id, "degraded-laptop");
  const evidence = executionProviderEvidence(providers, ["research", "artifact"]);
  assert.equal(evidence.selected.id, "online-desktop");
  assert.deepEqual(evidence.routing.results.map((entry) => [entry.provider_id, entry.eligible]), [
    ["offline-studio", false], ["degraded-laptop", false], ["online-desktop", true],
  ]);
  assert.equal(evidence.routing.results[0].gaps.availability.available, false);
  assert.deepEqual(evidence.routing.results[1].gaps.capability, ["artifact"]);
  assert.equal(evidence.routing.selection.escalated, true);
});

test("execution providers: capabilities split across providers are an unsupported combination", () => {
  const providers = [
    { id: "research", capabilities: ["research"] },
    { id: "calendar", capabilities: ["scheduling"] },
  ];
  assert.equal(selectExecutionProvider(providers, ["research"]), providers[0]);
  assert.equal(selectExecutionProvider(providers, ["research", "scheduling"]), null);
  const eligibility = executionEligibility({ max_concurrent_runs: 1, repository_required: false,
    required_capabilities: ["research", "scheduling"], resource_requirements: {} }, {
    capacity: 1, capabilities: ["research", "scheduling"], resource_limits: {}, providers,
  });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reasons[0].code, "provider_unavailable");
});

test("execution providers: command adapters and the existing project runtime share one contract", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-provider-runtime-"));
  let projectCalls = 0;
  const runtime = new CapabilityRuntime([
    { id: "software", kind: "project", capabilities: [] },
    { id: "operations", kind: "command", capabilities: ["research", "scheduling"], command: [
      process.execPath, "-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({received:JSON.parse(s).provider})))",
    ] },
  ], { execute: async () => { projectCalls += 1; return { passed: true, exit_code: 0 }; } });
  const project = { required_capabilities: [], timeout_ms: 10_000 };
  const baseJob = { work: { required_capabilities: [] }, project_context: { agent_profile: { id: "general" }, purpose: "test" } };
  const software = await runtime.execute({ project, job: baseJob, workspace, previous_failure: null, onStart: () => {} });
  assert.equal(projectCalls, 1);
  assert.deepEqual(software.provider, { id: "software", capabilities: [], required: [] });
  const operations = await runtime.execute({ project, job: { ...baseJob, work: { required_capabilities: ["research", "scheduling"] } },
    workspace, previous_failure: null, onStart: () => {} });
  assert.equal(projectCalls, 1);
  assert.equal(operations.output.received.id, "operations");
  assert.deepEqual(operations.provider.required, ["research", "scheduling"]);
});

test("execution providers: a below-threshold live probe closes the attempt before invocation", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-provider-confidence-"));
  let invoked = false;
  const runtime = new CapabilityRuntime([{
    id: "local-model", kind: "command", capabilities: ["research"], min_confidence: 0.8,
    probe: [process.execPath, "-e", "process.stdout.write(JSON.stringify({available:true,capabilities:['research'],confidence:0.6}))"],
    command: [process.execPath, "-e", "process.exit(99)"],
  }], { execute: async () => ({ passed: true }) });
  const result = await runtime.execute({
    project: { required_capabilities: ["research"], timeout_ms: 10_000 },
    job: { work: { required_capabilities: [] }, project_context: {} }, workspace,
    run: { attempt: 1, provider_id: "local-model" }, onStart: () => {}, onProviderStart: () => { invoked = true; },
  });
  assert.equal(result.passed, false);
  assert.equal(result.provider_failure.category, "confidence");
  assert.equal(result.provider_failure.action_status, "not_started");
  assert.equal(invoked, false);
});

test("execution providers: an active attempt is pinned to its selected provider", async () => {
  let calls = 0;
  const runtime = new CapabilityRuntime([{ id: "selected", kind: "project", capabilities: [] }], {
    execute: async () => { calls += 1; return { passed: true }; },
  });
  const request = { project: { required_capabilities: [] }, job: { work: { required_capabilities: [] } },
    run: { attempt: 1, provider_id: "different" } };
  await assert.rejects(runtime.execute(request), /cannot change within attempt 1/);
  assert.equal(calls, 0);
});

test("execution boundary: Remote Desktop Commander retains operational uses but cannot become a project runtime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-rdc-boundary-"));
  const filename = path.join(directory, "config.yaml");
  assert.deepEqual(REMOTE_DESKTOP_COMMANDER_PERMITTED_USES, [
    "transport", "inspection", "connectivity_check", "bootstrap", "emergency_repair",
  ]);
  assert.equal(isRemoteDesktopCommanderCommand(["/usr/local/bin/rdc"]), true);
  assert.equal(isRemoteDesktopCommanderCommand(["npx", "remote-desktop-commander"]), true);
  assert.equal(isRemoteDesktopCommanderCommand(["sh", "-c", "rdc agent run"]), true);
  assert.equal(isRemoteDesktopCommanderCommand(["sh", "-c", "exec /opt/remote-desktop-commander agent run"]), true);
  assert.equal(isRemoteDesktopCommanderCommand(["herdr"]), false);
  assert.equal(isRemoteDesktopCommanderCommand(["node", "/opt/rdc-notes.js"]), false);
  assert.equal(isRemoteDesktopCommanderCommand(["node", "/opt/remote-desktop-commander-notes.js"]), false);

  assert.throws(() => validateWorkflowConfig(manifest(directory, {
    executor: { kind: "command", command: ["rdc", "agent", "run"] },
  }), filename), /executor cannot use Remote Desktop Commander/);
  assert.throws(() => validateWorkflowConfig(manifest(directory, {
    executor: { kind: "command", command: ["sh", "-c", "rdc agent run"] },
  }), filename), /executor cannot use Remote Desktop Commander/);
  assert.throws(() => validateWorkflowConfig({ ...manifest(directory), execution: { providers: [
    { id: "rdc", kind: "command", capabilities: [], command: ["remote-desktop-commander"] },
  ] } }, filename), /Execution provider rdc cannot use Remote Desktop Commander/);
  assert.throws(() => validateWorkflowConfig(manifest(directory, {
    runtime: "herdr", herdr: { machine: "iMac", agent: "roundhouse-imac", bin: "rdc" },
  }), filename), /Herdr runtime cannot use Remote Desktop Commander/);
  assert.throws(() => new CapabilityRuntime([
    { id: "rdc", kind: "command", capabilities: [], command: ["rdc"] },
  ], { execute: async () => ({ passed: true }) }), /cannot use Remote Desktop Commander/);

  const ordinary = validateWorkflowConfig(manifest(directory), filename);
  assert.equal(ordinary.projects[0].runtime, "local");
});

test("scheduler contract: repository requirements are independent from capability requirements", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-repository-optional-"));
  const filename = path.join(directory, "config.yaml");
  const config = validateWorkflowConfig({
    execution: { capabilities: ["research"] },
    projects: [{
      id: "research", name: "Research", purpose: "Trace sources", success_state: "A reviewable artifact exists", status: "active",
      repository_required: false, required_capabilities: ["research", "artifact"], verification: [],
    }],
  }, filename);
  assert.equal(config.projects[0].repository, undefined);
  assert.equal(config.projects[0].repository_required, false);
  assert.deepEqual(config.projects[0].required_capabilities, ["research", "artifact"]);
  assert.equal(projectExecutionEligible(config.projects[0], config.execution), false);
  assert.throws(() => validateWorkflowConfig({
    projects: [{ id: "invalid", name: "Invalid", purpose: "Test", success_state: "Done", status: "active", verification: [] }],
  }, filename), /requires a repository/);
});

test("scheduler contract: machine-local Herdr validates and satisfies a remote repository requirement", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-machine-local-config-"));
  const filename = path.join(directory, "config.yaml");
  const configured = validateWorkflowConfig(manifest(undefined, {
    runtime: "herdr",
    herdr: { machine: "iMac", agent: "roundhouse-imac", workspace_mode: "machine_local", working_directory: "/home/ryngrn/kmac" },
    policy: { allow_autonomous: true, shipping: "push_branch" },
  }), filename).projects[0];
  assert.equal(configured.repository, undefined);
  assert.equal(executionEligibility(configured, { capacity: 1, capabilities: [], resource_limits: {}, providers: [{ id: "local-project", capabilities: [] }] }).eligible, true);
  assert.deepEqual(executionReservation(configured).repository, { required: true, configured: true, value: "/home/ryngrn/kmac" });
  assert.deepEqual(executionReservation(configured).locks, ["remote-repository:iMac:/home/ryngrn/kmac"]);
  assert.throws(() => validateWorkflowConfig(manifest(undefined, { runtime: "herdr", herdr: { machine: "iMac", agent: "roundhouse-imac", workspace_mode: "machine_local", working_directory: "relative" } }), filename), /must be absolute/);
  assert.throws(() => validateWorkflowConfig(manifest(directory, { herdr: { machine: "iMac", agent: "roundhouse-imac" } }), filename), /cannot configure herdr/);
});

test("scheduler contract: slice capabilities produce durable, specific ineligibility evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-slice-capability-"));
  const store = new Store(directory);
  const project = { id: "operations", status: "active", weight: 1, max_concurrent_runs: 1, repository_required: false,
    required_capabilities: ["research"], resource_requirements: {}, policy: { shipping: "commit_only" } };
  const job = { id: "operations-job", parent_id: "item", project_id: "operations", position: 0, state: "Ready", dependencies: [],
    attempts: [], history: [], work: { title: "Coordinate follow-up", repository_required: false,
      required_capabilities: ["integration", "scheduling", "artifact", "external-action", "human-task"] } };
  store.change((data) => {
    data.projects.operations = {};
    data.items.item = { id: "item", project_id: "operations", state: "Ready", input: { text: "Coordinate" }, questions: [], history: [], job_ids: [job.id] };
    data.jobs[job.id] = job;
    const considerations = dispatchConsiderations(data, [project], {
      capacity: 1, capabilities: ["research", "integration", "scheduling", "artifact"], resource_limits: {},
    }, { canDispatch: () => true });
    assert.equal(considerations[0].eligible, false);
    assert.deepEqual(considerations[0].reservation.constraints.capability.missing, ["external-action", "human-task"]);
    recordDispatchRound(data, considerations, null, 1, "2026-01-01T00:00:00.000Z");
  });
  const evidence = statusView(new Store(directory).read()).allocations.latest.operations;
  assert.equal(evidence.reason.code, "capability_mismatch");
  assert.match(evidence.reason.message, /external-action, human-task/);
  assert.deepEqual(evidence.constraints.repository, { required: false, configured: false, value: null, fits: true });
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
  assert.deepEqual(alpha.fairness, { weight: 3, allocations_before: 0, weighted_allocation: 0, rank: 1 });
  assert.deepEqual(alpha.constraints.capability, { required: ["cpu"], available: ["cpu"], missing: [], fits: true });
  assert.deepEqual(alpha.constraints.provider, { selected: null, fits: true });
  assert.equal(alpha.constraints.capacity.limit, 2);
  assert.equal(alpha.constraints.resources[0].resource, "browser");
  assert.match(view.allocations.latest.beta.reason.message, /weighted allocation/);
  assert.equal(view.items[0].jobs[0].allocation.job_id, "alpha-job");
});

test("scheduler contract: dependency holds do not prevent a later independent slice", () => {
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
