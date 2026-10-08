import test from "node:test";
import assert from "node:assert/strict";
import { itemView, notificationView } from "../src/workflow/views.js";

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
