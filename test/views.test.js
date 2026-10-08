import test from "node:test";
import assert from "node:assert/strict";
import { dashboardProjection, itemView, notificationView } from "../src/workflow/views.js";

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

test("dashboard projection is job-level and counts blocked, held, queued, and shipped work canonically", () => {
  const history = (state, reason = state) => [{ from: "Ready", to: state, reason, at: "2026-01-01T00:00:00Z" }];
  const work = (title) => ({ title, acceptance_criteria: [{ description: `${title} passes` }] });
  const parent = { id: "parent", state: "Ready", revision: 1, project_id: "example", input: { text: "Nested work" },
    history: [], questions: [], job_ids: ["blocked", "held", "queued", "shipped"] };
  const data = {
    items: {
      parent,
      clarification: { id: "clarification", state: "Needs Clarification", revision: 2, project_id: "example",
        input: { text: "Need a decision" }, history: history("Needs Clarification", "Choose a safe option."), questions: [], job_ids: [] },
      history: { id: "history", state: "Imported History", revision: 1, project_id: "example",
        input: { text: "Earlier delivery" }, history: [], questions: [], job_ids: [] },
    },
    jobs: {
      blocked: { id: "blocked", parent_id: "parent", state: "Blocked", revision: 2, project_id: "example", dependencies: [],
        history: history("Blocked", "Verification failed."), work: work("Blocked job"), attempts: [] },
      held: { id: "held", parent_id: "parent", state: "Ready", revision: 1, project_id: "example", dependencies: ["blocked"],
        history: [], work: work("Held job"), attempts: [] },
      queued: { id: "queued", parent_id: "parent", state: "Ready", revision: 1, project_id: "example", dependencies: ["held"],
        history: [], work: work("Queued job"), attempts: [] },
      shipped: { id: "shipped", parent_id: "parent", state: "Shipped", revision: 3, project_id: "example", dependencies: [],
        history: history("Shipped"), work: work("Shipped job"), attempts: [], shipping: { commit: "abc", outputs: [] } },
    },
    projects: { example: { blocked: false, stop: false, review_required: false } },
    project_candidates: {}, system_metadata: {}, outbox: [],
  };
  const config = { projects: [{ id: "example", status: "active", runtime: "herdr" }] };
  const projection = dashboardProjection(data, config);
  assert.deepEqual(projection.overview.items.map((item) => item.id).sort(), ["blocked", "clarification", "held", "history", "queued", "shipped"]);
  assert.ok(!projection.overview.items.some((item) => item.id === "parent"));
  assert.deepEqual(projection.overview.counts, {
    needs_review: 3, needs_you: 3, active: 0, queued: 1, completed: 2, blocked: 1,
  });
  assert.equal(projection.overview.items.find((item) => item.id === "held").review_kind, "blocked");
  assert.equal(projection.overview.items.find((item) => item.id === "queued").review_required, false);
  assert.equal(projection.overview.projection_revision, projection.projection_revision);
  assert.equal(dashboardProjection(structuredClone(data), config).projection_revision, projection.projection_revision);
});
