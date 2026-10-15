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
    needs_review: 0, needs_you: 0, active: 0, queued: 2, completed: 2, blocked: 1,
  });
  assert.equal(projection.overview.items.find((item) => item.id === "held").review_kind, null);
  assert.equal(projection.overview.items.find((item) => item.id === "blocked").bottleneck, true);
  assert.equal(projection.overview.items.find((item) => item.id === "blocked").blocked_dependents, 1);
  assert.equal(projection.overview.items.find((item) => item.id === "held").bottleneck, false);
  assert.equal(projection.overview.items.find((item) => item.id === "queued").review_required, false);
  assert.match(projection.overview.items.find((item) => item.id === "queued").dispatch_hold, /blocked \(Blocked\)/);
  assert.equal(projection.overview.projection_revision, projection.projection_revision);
  assert.equal(dashboardProjection(structuredClone(data), config).projection_revision, projection.projection_revision);
});


test("previously answered cleanup cannot hide an outstanding Review approval",()=>{
 const parent={id:"growthpath",state:"Review",revision:8,project_id:"example",
   input:{text:"Product decision confirmed, execution approval pending"},history:[],
   issue_resolution:{status:"answered",response:{action:"option"}},questions:[],job_ids:[]};
 const data={items:{growthpath:parent},jobs:{},projects:{example:{id:"example",name:"Example"}},
   outbox:[],system_metadata:{}};
 const projected=dashboardProjection(data,{projects:[{id:"example",name:"Example",status:"active"}]}).overview;
 assert.equal(projected.items.length,1);
 assert.equal(projected.items[0].state,"Review");
 assert.equal(projected.items[0].review_required,true);
 assert.equal(projected.counts.needs_review,1);
});

test("answered and terminal stale questions do not return to the actionable review queue", () => {
  const make = (id, state, issue_resolution = null) => ({
    id, state, project_id: "example", revision: 1, input: { text: id },
    history: [], job_ids: [], issue_resolution,
    questions: [{ id: id + "-q", decision_key: "old", revision: 1, status: "open", prompt: "Old question" }],
  });
  const data = { items: {
    archived: make("archived", "Archived"),
    blocked: make("blocked", "Blocked", { status: "waiting", question: "Cleanup?" }),
    decision: make("decision", "Decision"),
    answered: make("answered", "Needs Clarification", { status: "answered", response: { action: "custom" } }),
    current: make("current", "Needs Clarification"),
    approval: make("approval", "Review", { status: "answered" }),
  }, jobs: {}, projects: {}, outbox: [] };
  const projected = dashboardProjection(data, { projects: [{ id: "example", status: "active" }] }).overview;
  assert.deepEqual(projected.needs_you.map(question => question.item_id).sort(), ["approval", "current"]);
  assert.equal(projected.items.find(item => item.id === "answered").review_required, false);
  assert.equal(projected.items.find(item => item.id === "approval").review_required, true);
});

test("a Ready slice blocked by a prerequisite is not dispatch-gate-open", () => {
  const parent = { id: "i", state: "Ready", revision: 1, project_id: "example",
    input: { text: "Work" }, history: [], questions: [], job_ids: ["blocked", "held", "free"] };
  const job = (id, state, deps = []) => ({ id, parent_id: "i", state, revision: 1, project_id: "example",
    dependencies: deps, history: [], attempts: [], work: { title: id } });
  const data = { items: { i: parent }, jobs: {
    blocked: job("blocked", "Blocked"), held: job("held", "Ready", ["blocked"]),
    free: job("free", "Ready"),
  }, projects: {}, outbox: [] };
  const items = dashboardProjection(data, { projects: [{ id: "example", status: "active", runtime: "local" }] }).overview.items;
  assert.equal(items.find(item => item.id === "held").dispatch_gate_open, false);
  assert.match(items.find(item => item.id === "held").dispatch_hold, /prerequisite blocked/);
  assert.equal(items.find(item => item.id === "free").dispatch_gate_open, true);
  assert.equal(items.find(item => item.id === "blocked").dispatch_gate_open, false);
});
