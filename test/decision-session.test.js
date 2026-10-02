import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/workflow/engine.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { parseLegacyEnumeratedDecisions } from "../src/workflow/legacy-decisions.js";
import { harness } from "./support/harness.js";

const prompts = [
  "Oldest iPad/iPadOS target",
  "Whether a jailbreak is acceptable for the earliest proof",
  "First Linux desktop/compositor target",
  "Whether v1 includes touch",
  "Virtual monitor vs dedicated display surface default",
  "Automatic vs manual face-mode switching",
  "Licensing permission before code reuse",
];

function seedSession(h, count = prompts.length) {
  const item = h.submit("iPad Monitor feasibility", `session-${count}`);
  h.store.change((data) => {
    const current = data.items[item.id];
    current.state = "Imported Pending";
    current.requires_reevaluation = true;
    current.execution_eligible = false;
    current.questions = prompts.slice(0, count).map((prompt, index) => ({
      id: `question-${index + 1}`, decision_id: null, decision_key: `ipad:${index + 1}`,
      item_id: item.id, item_revision: current.revision, revision: 1, kind: "imported_decision",
      prompt, status: "open", created_at: current.created_at, updated_at: current.updated_at,
    }));
  });
  return h.store.read().items[item.id];
}

function executableDecision(project) {
  return {
    project: project.id, project_confidence: 0.99, execution_confidence: 0.99,
    sufficient_context: true, safe_to_execute: true, approval_required: false,
    decision: "execute", reason: "All material decisions were answered.", questions: [],
    dependencies: [], executor: project.executor.kind, runtime: project.runtime, shipping_policy: project.policy.shipping,
    should_decompose: false,
    work_items: [{ title: "Validate iPad monitor", outcome: "The selected product direction is validated.",
      acceptance_criteria: [{ description: "Configured checks pass.", verification_ids: ["feature"] }] }],
  };
}

test("batch decision session validates then persists every answer atomically and re-evaluates once", async (t) => {
  const h = harness(); t.after(() => h.store.change(() => null));
  const item = seedSession(h);
  let reevaluations = 0;
  const engine = new Engine({ store: h.store, config: h.config, decision: { decide: async ({ projects }) => { reevaluations += 1; return executableDecision(projects[0]); } } });
  const answers = item.questions.map((question, index) => ({ question_id: question.id, expected_revision: question.revision, answer: `Answer ${index + 1}` }));

  const result = await engine.answerDecisionSession(item.id, item.revision, answers, "test-user");
  assert.equal(reevaluations, 1);
  assert.equal(result.state, "Ready", result.history.at(-1)?.reason);
  assert.equal(result.questions.filter((question) => question.status === "answered").length, 7);
  assert.deepEqual(result.clarifications.slice(-7).map((entry) => entry.text), answers.map((entry) => entry.answer));
  assert.equal(result.decision_sessions.length, 1);
  assert.equal(result.decision_sessions[0].answers.length, 7);
});

test("stale item or question revision applies zero answers and returns structured conflict", async () => {
  const h = harness();
  const item = seedSession(h, 2);
  let reevaluations = 0;
  const engine = new Engine({ store: h.store, config: h.config, decision: { decide: async ({ projects }) => { reevaluations += 1; return executableDecision(projects[0]); } } });
  const before = structuredClone(h.store.read().items[item.id]);
  const answers = item.questions.map((question, index) => ({ question_id: question.id, expected_revision: question.revision, answer: `Answer ${index + 1}` }));
  answers[1].expected_revision += 1;

  await assert.rejects(() => engine.answerDecisionSession(item.id, item.revision, answers, "test-user"), (error) => {
    assert.equal(error.code, "decision_session_conflict");
    assert.equal(error.details.item_id, item.id);
    assert.equal(error.details.questions.length, 2);
    return true;
  });
  assert.deepEqual(h.store.read().items[item.id], before);
  assert.equal(reevaluations, 0);
});

test("legacy imported sequential enumeration becomes durable focused questions and retains its source prompt", () => {
  const h = harness();
  const item = h.submit("Imported idea", "legacy-seven");
  const compound = prompts.map((prompt, index) => `${index + 1}) ${prompt}.`).join(" ");
  assert.equal(parseLegacyEnumeratedDecisions(compound).length, 7);
  h.store.change((data) => {
    const current = data.items[item.id]; current.state = "Imported Pending"; current.requires_reevaluation = true; current.execution_eligible = false;
    current.questions = [{ id: "legacy-compound", decision_id: null, decision_key: "legacy:ipad", item_id: item.id,
      item_revision: current.revision, revision: 1, kind: "imported_decision", prompt: compound, status: "open",
      created_at: current.created_at, updated_at: current.updated_at }];
  });
  new RoundhouseService({ store: h.store, engine: h.engine });
  const migrated = h.store.read().items[item.id];
  assert.equal(migrated.questions[0].status, "normalized");
  assert.equal(migrated.questions.filter((question) => question.status === "open").length, 7);
  assert.ok(migrated.questions.slice(1).every((question) => question.provenance.source_prompt === compound));
  assert.equal(migrated.domain_migrations[0].id, "notion-enumerated-decisions-v1");
});
