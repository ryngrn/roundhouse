import test from "node:test";
import assert from "node:assert/strict";
import { itemView, notificationView, statusView } from "../src/workflow/views.js";

test("completed Designer outcome appends Roundhouse delivery evidence to the executor summary", () => {
  const item = { id: "item", state: "Ready", revision: 1, project_id: "example", input: { text: "Design" }, history: [], questions: [], job_ids: ["job"] };
  const data = { items: { item }, jobs: { job: {
    id: "job", parent_id: "item", state: "Shipped", agent_role: "designer", history: [], work: { title: "Improve hero" },
    attempts: [{ execution: { report: { summary: "Implemented the hero; deployment is owned by Roundhouse.", design_decisions: [], evidence: [] } } }],
    shipping: { commit: "abc", branch: "preview", pushed: false, timestamp: "2026-01-01T00:00:00Z", verification: { checks: [] }, deployment: { deploy_url: "https://preview.example" } },
  } }, projects: {}, outbox: [] };
  const view = itemView(data, item);
  assert.match(view.outcome, /verified and shipped by Roundhouse/);
  assert.match(view.outcome, /https:\/\/preview\.example/);
});

test("status exposes durable decision, job, and attempt provider evidence while legacy state remains readable", () => {
  const evidence = { configured: [{ id: "software", kind: "project", capabilities: [] }],
    selected: { id: "software", kind: "project", capabilities: [] },
    invoked: { id: "software", kind: "project", capabilities: [] },
    capability_probe: { required: [], results: [{ provider_id: "software", required: [], missing: [], supported: true }] } };
  const item = { id: "item", state: "Ready", revision: 1, project_id: "example", input: { text: "Build" },
    history: [], questions: [], job_ids: ["job"], decision: { work_items: [], provider_evidence: evidence } };
  const job = { id: "job", parent_id: "item", project_id: "example", state: "Executing", history: [],
    work: { title: "Build" }, attempts: [{ number: 1, provider_evidence: evidence }], provider_evidence: evidence,
    execution_outcome: { classification: "native_success" } };
  const view = itemView({ items: { item }, jobs: { job }, projects: {} }, item);
  assert.equal(view.decision_provider.invoked.id, "software");
  assert.equal(view.jobs[0].provider_evidence.selected.id, "software");
  assert.equal(view.jobs[0].latest_attempt_provider.invoked.id, "software");
  assert.equal(view.jobs[0].execution_outcome.classification, "native_success");

  const legacyItem = { ...item, decision: { work_items: [] } };
  const legacyJob = { ...job, attempts: [], provider_evidence: undefined };
  const legacyView = itemView({ items: { item: legacyItem }, jobs: { job: legacyJob }, projects: {} }, legacyItem);
  assert.equal(legacyView.decision_provider, null);
  assert.equal(legacyView.jobs[0].provider_evidence, null);
});

test("status safely projects durable Herdr placement evidence across attempt lifecycle states", () => {
  const placement = {
    authority: { control_plane: "roundhouse", placement: "herdr", credential: "PLACEMENT_SECRET" },
    configuration_identity: "policy-hash",
    requirements: { runtime: "herdr", credential: "PLACEMENT_SECRET" },
    eligible: [{ machine: "Studio-iMac", token: "PLACEMENT_SECRET" }],
    selection: {
      runtime: "herdr", machine: "Studio-iMac", platform: "macos", tool: "claude", agent: "general-worker",
      matched_capabilities: ["browser", "repository"], rationale: "Closest eligible worker.", source: "herdr_scheduler",
      credential: "PLACEMENT_SECRET",
    },
    hold: null,
    source: "herdr_scheduler",
    observed_at: "2026-10-08T00:00:00.000Z",
    access_token: "PLACEMENT_SECRET",
  };
  for (const state of ["Executing", "Rework", "Blocked", "Reconciled", "Shipped"]) {
    const item = { id: `item-${state}`, state, revision: 1, project_id: "example", input: { text: state },
      history: [], questions: [], job_ids: [`job-${state}`], decision: { work_items: [] } };
    const job = { id: `job-${state}`, parent_id: item.id, project_id: "example", state, history: [],
      work: { title: state }, project_context: { runtime: "herdr", herdr: { machine: "configured-only" } },
      reconciliation: { status: "confirmed", intent: { report_token: "PLACEMENT_SECRET", branch: "work" } },
      attempts: [{ number: 1, status: state === "Shipped" ? "completed" : "failed",
        placement, run: { id: "run", status: "completed", placement, credential: "PLACEMENT_SECRET" },
        execution: { remote_execution: { runtime: "herdr", execution_id: "remote-1", placement,
          report_token: "PLACEMENT_SECRET" } } }],
    };
    const projected = statusView({ items: { [item.id]: item }, jobs: { [job.id]: job }, projects: {} }).items[0].jobs[0];
    assert.deepEqual(projected.placement.selection, {
      runtime: "herdr", machine: "Studio-iMac", platform: "macos", tool: "claude", agent: "general-worker",
      matched_capabilities: ["browser", "repository"], rationale: "Closest eligible worker.", source: "herdr_scheduler",
    });
    assert.equal(projected.placement.source, "herdr_scheduler");
    assert.equal(projected.placement_history[0].placement.observed_at, "2026-10-08T00:00:00.000Z");
    assert.equal(projected.machine, "Studio-iMac");
    assert.doesNotMatch(JSON.stringify(projected), /PLACEMENT_SECRET/);
  }
});

test("status distinguishes placement, provider, dependency, and project quarantine causes", () => {
  const item = { id: "item", state: "Blocked", revision: 1, project_id: "example", input: { text: "Held work" },
    history: [], questions: [], job_ids: ["placement", "provider", "dependency"], decision: { work_items: [] } };
  const base = { parent_id: "item", project_id: "example", state: "Blocked", history: [], work: { title: "Held" } };
  const jobs = {
    placement: { ...base, id: "placement", dependencies: [], hold: { scope: "job", code: "placement_unavailable", reason: "No worker is online." },
      attempts: [{ number: 1, placement: { selection: null, hold: { code: "placement_unavailable", reason: "No worker is online.", missing_capabilities: [] }, source: "herdr_scheduler" } }] },
    provider: { ...base, id: "provider", dependencies: [], hold: { scope: "job", code: "unsafe_or_uncertain", reason: "Provider failed." },
      attempts: [{ number: 1, provider_failure: { category: "availability", code: "provider_unavailable", message: "Provider failed." } }] },
    dependency: { ...base, id: "dependency", state: "Ready", dependencies: ["placement"], attempts: [] },
  };
  const view = itemView({ items: { item }, jobs, projects: { example: { blocked: true,
    quarantine: { code: "interrupted_attempt", reason: "Inspect remote state." } } } }, item);
  assert.equal(view.jobs.find((job) => job.id === "placement").hold.kind, "placement");
  assert.equal(view.jobs.find((job) => job.id === "provider").hold.kind, "provider");
  assert.equal(view.jobs.find((job) => job.id === "dependency").hold.kind, "dependency");
  assert.equal(view.project_gate.cause.kind, "quarantine");
  assert.equal(view.jobs.find((job) => job.id === "provider").provider_failure.category, "availability");
});

test("notification projection keeps only meaningful events and deduplicates event IDs", () => {
  const events = [
    { id: "quiet", item_id: "item", entity_id: "item", state: "Decision", reason: "routing", at: "2026-01-01T00:00:00Z" },
    { id: "needs", item_id: "item", entity_id: "item", state: "Review", reason: "approve?", at: "2026-01-01T00:00:01Z" },
    { id: "needs", item_id: "item", entity_id: "item", state: "Review", reason: "duplicate", at: "2026-01-01T00:00:02Z" },
    { id: "blocked", item_id: "item", entity_id: "job", state: "Blocked", reason: "failed", at: "2026-01-01T00:00:03Z" },
    { id: "done", item_id: "item", entity_id: "job", state: "Shipped", reason: "delivered", at: "2026-01-01T00:00:04Z" },
  ];
  const data = {
    outbox: events,
    items: { item: { id: "item", project_id: "example" } },
    jobs: { job: { id: "job", project_id: "example" } },
  };
  const result = notificationView(data);
  assert.deepEqual(result.notifications.map((event) => event.kind), ["needs_you", "failure", "completion"]);
  assert.equal(result.cursor, "done");
  assert.deepEqual(notificationView(data, { after: "needs" }).notifications.map((event) => event.id), ["blocked", "done"]);
  assert.deepEqual(notificationView(data, { after: "blocked" }).notifications.map((event) => event.id), ["done"]);
});
