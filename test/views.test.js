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

test('outcome-first projection groups attempts without claiming failed work shipped', () => {
  const parent = {id:'intent',state:'Ready',revision:1,project_id:'example',input:{text:'Provide working feature'},history:[],questions:[],job_ids:['old','new']};
  const obsolete = {id:'obsolete',state:'Archived',revision:2,project_id:'example',input:{text:'Historical wrapper'},history:[],questions:[{id:'stale',revision:1,status:'open',prompt:'Old question'}],job_ids:[]};
  const data = {items:{intent:parent,obsolete},jobs:{
    old:{id:'old',parent_id:'intent',project_id:'example',state:'Blocked',revision:2,history:[],work:{title:'Failed attempt'},attempts:[],dependencies:[]},
    new:{id:'new',parent_id:'intent',project_id:'example',state:'Shipped',revision:2,history:[],work:{title:'Verified delivery'},attempts:[],dependencies:[],shipping:{commit:'abc'}},
  },projects:{example:{}},outbox:[],system_metadata:{}};
  const overview = dashboardProjection(data,{projects:[{id:'example',name:'Example',status:'active',runtime:'local'}]}).overview;
  const outcome = overview.outcomes.find(x=>x.intent_id==='intent');
  assert.deepEqual(outcome.work_ids.sort(),['new','old']);
  assert.deepEqual(outcome.blocked_work_ids,['old']);
  assert.deepEqual(outcome.verified_work_ids,['new']);
  assert.equal(outcome.status,'pending');
  assert.equal(overview.needs_you.find(x=>x.item_id==='obsolete'),undefined);
});
