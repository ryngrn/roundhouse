import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./support/harness.js";
import { RoundhouseService } from "../src/workflow/service.js";

test("intent-first program: raw idea -> discovery -> two gates -> slices -> shipment -> grounded outcome", async () => {
  const h = harness();
  h.store.change((data) => {
    data.projects.example = { id: "example", name: "Example", revision: 1 };
  });
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  await service.initialize();

  const goalResult = service.createGoal({
    project_id: "example", expected_project_revision: 1, actor: "product-owner",
    goal: { id: "activation", title: "Increase activation", description: "Turn qualified visits into activated users.",
      why: "Activation is the current growth constraint.", success_criteria: "Reach at least 10% conversion.",
      measurable_target: { metric: "conversion_rate", value: 0.1 } },
  });
  service.createFeature({
    project_id: "example", expected_project_revision: goalResult.project_revision, actor: "product-owner",
    feature: { id: "guided-onboarding", title: "Guided onboarding", description: "Help a new user reach first value.",
      why: "New users currently lack a clear path.", success_criteria: "Qualified traffic converts at 10% or better.",
      completion_type: "Done when outcome reached", goal_ids: ["activation"] },
  });

  const source = {
    content: "decompose a broad guided onboarding program into sequential implementation slices",
    project_hint: "example", idempotency_key: "intent-program-e2e",
    context: { customer_signal: "Users do not know the first useful action." },
    metadata: { intent_scope: "broad", intent: { feature_id: "guided-onboarding", goal_ids: ["activation"],
      completion_type: "Done when outcome reached" } },
  };
  const submitted = service.addToDepot(source, { source: "test", actor: "product-owner" });
  const originalInput = structuredClone(h.store.read().items[submitted.item.id].input);
  assert.equal(submitted.item.project_hint, "example");
  assert.equal(submitted.item.intent.status, "discovering");
  assert.equal(submitted.item.intent.discovery_non_executable, true);
  assert.equal(submitted.item.raw_idea.text, source.content);
  assert.equal(submitted.item.intent.original_context_reference, submitted.item.raw_idea.id);

  await h.engine.runTriage();
  let state = h.store.read();
  let item = state.items[submitted.item.id];
  assert.equal(item.state, "Needs Clarification");
  assert.equal(item.questions.filter((question) => question.status === "open").length, 1);
  assert.equal(item.intent.work_slices.length, 2);
  assert.deepEqual(item.job_ids, []);

  const question = item.questions.find((candidate) => candidate.status === "open");
  const answered = service.answerIntentQuestion({ item_id: item.id, expected_item_revision: item.revision,
    question_id: question.id, expected_question_revision: question.revision,
    answer: "Improve activation without public posting, spending, or permission changes.",
    fields: { desired_outcome: "Improve qualified-user activation", scope_boundaries: ["No public posting", "No spending", "No permission changes"] },
    actor: "product-owner" });
  assert.equal(answered.reevaluated, false);
  assert.equal(answered.item.intent.status, "ready_for_confirmation");
  assert.deepEqual(h.store.read().items[item.id].job_ids, []);

  assert.throws(() => service.confirmIntent({ item_id: item.id, expected_item_revision: answered.item.revision,
    feature_id: "guided-onboarding", goal_ids: ["activation"], fields: { audience: "qualified new users" }, actor: "product-owner" }),
    /confirmed problem/);
  assert.equal(h.store.read().items[item.id].state, "Needs Clarification");
  assert.equal(h.store.read().items[item.id].job_ids.length, 0);
  const confirmed = service.confirmIntent({ item_id: item.id, expected_item_revision: answered.item.revision,
    feature_id: "guided-onboarding", goal_ids: ["activation"], fields: { audience: "qualified new users", problem: "New users cannot reach first value", success_criteria: "At least 10% of qualified users activate" }, actor: "product-owner" });
  assert.equal(confirmed.item.state, "Review");
  assert.equal(confirmed.item.intent.status, "confirmed");
  assert.equal(confirmed.planning_confirmed, true);
  assert.equal(confirmed.execution_approved, false);
  assert.deepEqual(h.store.read().items[item.id].job_ids, []);

  const approved = service.approveItem({ id: item.id, expected_revision: confirmed.item.revision, actor: "delivery-owner" });
  assert.equal(approved.item.intent.status, "execution_approved");
  state = h.store.read();
  assert.equal(state.items[item.id].job_ids.length, 2);
  assert.deepEqual(state.projects.example.features[0].work_item_ids, [item.id]);
  assert.equal(new Set(state.items[item.id].job_ids).size, 2);
  assert.ok(state.items[item.id].intent.work_slices.every((slice) => slice.work_item_id === item.id && slice.job_id));

  const research = service.proposeResearch({ project_id: "example", expected_project_revision: state.projects.example.revision,
    feature_id: "guided-onboarding", unknown: "Which onboarding path changes activation enough to justify implementation?",
    options: [
      { id: "checklist", title: "Checklist", pros: ["Low complexity"], cons: ["May be ignored"] },
      { id: "wizard", title: "Guided wizard", pros: ["High guidance"], cons: ["More friction"] },
    ], recommendation: "Test the checklist first because it is reversible and cheaper to validate.",
    citations: [{ source: "customer-research", reference: "interviews/2026-10-08", note: "Five observed sessions" }],
    external_action: true, actor: "researcher" });
  assert.equal(research.research.status, "approval_required");
  assert.equal(research.dispatched, false);

  const shipped = await h.engine.runDispatch();
  assert.equal(shipped.executed, 2);
  assert.ok(Object.values(shipped.jobs).every((job) => job.state === "Shipped" && job.attempts.length === 1));
  const repeated = await h.engine.runDispatch();
  assert.equal(repeated.executed, 0);
  assert.ok(Object.values(repeated.jobs).every((job) => job.attempts.length === 1));
  state = h.store.read();
  assert.equal(state.projects.example.features[0].status, "Shipped; outcome pending");

  const unavailable = service.evaluateGoal({ project_id: "example", expected_project_revision: state.projects.example.revision,
    goal_id: "activation", metrics: {}, evidence: [], data_status: "unavailable", actor: "analyst" });
  assert.equal(unavailable.evaluation.result, "data_unavailable");

  const noTraffic = service.evaluateGoal({ project_id: "example", expected_project_revision: unavailable.project_revision,
    goal_id: "activation", metrics: { visits: 0, signups: 0 },
    evidence: [{ source: "analytics-export", reference: "snapshot:no-traffic" }],
    hypotheses: ["The launch has not reached qualified users."],
    experiments: [{ id: "distribution-review", title: "Review distribution", description: "Choose a safe distribution test." }],
    next_evaluation_at: "2026-10-15T00:00:00.000Z", actor: "analyst" });
  assert.equal(noTraffic.evaluation.result, "no_traffic");
  assert.equal(noTraffic.evaluation.experiments[0].decision_required, true);

  const poorConversion = service.evaluateGoal({ project_id: "example", expected_project_revision: noTraffic.project_revision,
    goal_id: "activation", metrics: { visits: 100, signups: 2, conversion_rate: 0.02 },
    evidence: [{ source: "analytics-export", reference: "snapshot:poor-conversion" }], actor: "analyst" });
  assert.equal(poorConversion.evaluation.result, "poor_conversion");

  const achieved = service.evaluateGoal({ project_id: "example", expected_project_revision: poorConversion.project_revision,
    goal_id: "activation", metrics: { visits: 100, signups: 12, conversion_rate: 0.12 },
    evidence: [{ source: "analytics-export", reference: "snapshot:target-reached" }], actor: "analyst" });
  assert.equal(achieved.evaluation.result, "achieved_target");
  assert.equal(achieved.goal.status, "Achieved");
  state = h.store.read();
  assert.equal(state.projects.example.features[0].status, "Achieved");
  assert.deepEqual(state.items[item.id].input, originalInput);

  const overview = service.getDashboardProjection().overview;
  assert.equal(overview.projects.example.name, "Example");
  assert.equal(overview.projects.example.goals[0].evaluations.length, 4);
  assert.equal(overview.projects.example.features[0].work_item_ids[0], item.id);
  const projected = overview.items.filter((entry) => entry.project_id === "example");
  assert.ok(projected.every((entry) => entry.intent.feature_id === "guided-onboarding"));
  assert.ok(projected.every((entry) => entry.project_name === "Example"));
});

test("completion types are exact and tactical work keeps the existing fast lane", async () => {
  const h = harness();
  h.store.change((data) => { data.projects.example = { id: "example", name: "Example", revision: 1 }; });
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  assert.throws(() => service.createFeature({ project_id: "example", expected_project_revision: 1,
    feature: { title: "Bad", description: "Bad", why: "Bad", completion_type: "shipped", goal_ids: [] } }), /exactly/);
  const tactical = service.addToDepot({ content: "small tactical copy fix", project_hint: "example", idempotency_key: "tactical-fast-lane" },
    { source: "test", actor: "operator" });
  assert.equal(tactical.item.intent.status, "tactical_fast_lane");
  const result = await h.engine.run();
  assert.equal(result.items[tactical.item.id].job_ids.length, 1);
  assert.equal(result.jobs[result.items[tactical.item.id].job_ids[0]].state, "Shipped");
});


test("project icon updates are durable, revision-guarded and reject unsafe values", () => {
  const h = harness();
  h.store.change((data) => { data.projects.example = { id: "example", name: "Example", revision: 1 }; });
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const saved = service.setProjectIcon({ project_id: "example", expected_project_revision: 1, icon: "🚂", actor: "owner" });
  assert.equal(saved.project_revision, 2);
  assert.equal(saved.icon, "🚂");
  assert.equal(h.store.read().projects.example.icon, "🚂");
  assert.equal(service.getDashboardProjection().overview.projects.example.icon, "🚂");
  assert.throws(() => service.setProjectIcon({ project_id: "example", expected_project_revision: 1, icon: "🎨" }), /changed/);
  assert.throws(() => service.setProjectIcon({ project_id: "example", expected_project_revision: 2, icon: "<script>" }), /emoji/);
  assert.throws(() => service.setProjectIcon({ project_id: "example", expected_project_revision: 2, icon: "🎨🎨" }), /emoji/);
});

test("feature intent updates are atomic, revision-fenced, audited, and keep clarification in Inbox", () => {
  const h = harness();
  h.store.change((data) => {
    data.projects.example = { id: "example", name: "Example", revision: 4, features: [{
      id: "guided-onboarding", title: "Guided onboarding", why: "Slow first value", revision: 2,
      success_criteria: "Activation improves", research: ["Baseline"], proposed_options: [], work_item_ids: ["question-item"],
    }] };
    data.items["question-item"] = { id: "question-item", state: "Needs Clarification", revision: 3,
      input: { text: "Choose the onboarding audience", source: "test", actor: "owner" }, project_id: "example",
      job_ids: [], history: [], clarifications: [],
      questions: [{ id: "question", status: "open", prompt: "Which audience is decision-critical?", revision: 1 }] };
  });
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  const beforeProjection = service.getDashboardProjection().projection_revision;
  const saved = service.updateFeatureIntent({
    project_id: "example", feature_id: "guided-onboarding", expected_project_revision: 4, expected_feature_revision: 2,
    fields: { why: "  Users wait for guidance.  ", desired_outcome: "", success_criteria: ["First value in one day", ""],
      research: [], proposed_options: null }, clarification_behavior: "ask_if_required", actor: "owner",
  });
  assert.equal(saved.project_revision, 5);
  assert.equal(saved.feature_revision, 3);
  assert.equal(saved.clarification_required, true);
  assert.deepEqual(saved.inbox_item_ids, ["question-item"]);
  const state = h.store.read();
  const feature = state.projects.example.features[0];
  assert.equal(feature.why, "Users wait for guidance.");
  assert.equal(feature.desired_outcome, null);
  assert.deepEqual(feature.success_criteria, ["First value in one day"]);
  assert.deepEqual(feature.research, []);
  assert.equal(feature.proposed_options, null);
  assert.equal(state.items["question-item"].questions.length, 1);
  assert.equal(feature.intent_audit.length, 1);
  assert.deepEqual(feature.intent_audit[0].changed_fields,
    ["why", "desired_outcome", "success_criteria", "research", "proposed_options"]);
  assert.equal(feature.intent_audit[0].actor, "owner");
  assert.notEqual(service.getDashboardProjection().projection_revision, beforeProjection);
  assert.equal(service.getDashboardProjection().overview.projects.example.features[0].revision, 3);

  assert.throws(() => service.updateFeatureIntent({ project_id: "example", feature_id: "guided-onboarding",
    expected_project_revision: 4, expected_feature_revision: 3, fields: { why: "stale" } }), /Project changed/);
  assert.throws(() => service.updateFeatureIntent({ project_id: "example", feature_id: "guided-onboarding",
    expected_project_revision: 5, expected_feature_revision: 2, fields: { why: "stale" } }), /Feature changed/);
  assert.throws(() => service.updateFeatureIntent({ project_id: "example", feature_id: "other",
    expected_project_revision: 5, fields: { why: "wrong scope" } }), /outside this project/);
  assert.throws(() => service.updateFeatureIntent({ project_id: "example", feature_id: "guided-onboarding",
    expected_project_revision: 5, fields: { status: "Shipped" } }), /unsupported/);
});

test("legacy features project revision one and optional blank edits do not create clarification", () => {
  const h = harness();
  h.store.change((data) => { data.projects.example = { id: "example", revision: 1,
    features: [{ id: "legacy", why: "Original", work_item_ids: [] }] }; });
  const service = new RoundhouseService({ store: h.store, engine: h.engine });
  assert.equal(service.getDashboardProjection().overview.projects.example.features[0].revision, 1);
  const saved = service.updateFeatureIntent({ project_id: "example", feature_id: "legacy",
    expected_project_revision: 1, expected_feature_revision: 1, fields: { why: null, research: [] } });
  assert.equal(saved.clarification_required, false);
  assert.deepEqual(saved.inbox_item_ids, []);
  assert.equal(saved.feature_revision, 2);
});
