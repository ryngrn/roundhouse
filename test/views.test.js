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
