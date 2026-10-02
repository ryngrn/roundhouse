import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferRoutineAcceptanceCriteria, routeDecision } from "../src/workflow/decision.js";
import { composeAgentRole, inferAgentRole } from "../src/workflow/roles.js";
import { projectContext, validateWorkflowConfig } from "../src/workflow/config.js";
import { CommandVerifier } from "../src/workflow/runtime.js";
import { Store } from "../src/workflow/store.js";
import { harness } from "./support/harness.js";

function inclusionDecision(overrides = {}) {
  return {
    project: "inclusion", project_confidence: 0.99, execution_confidence: 0.94,
    sufficient_context: true, safe_to_execute: true, approval_required: false,
    decision: "execute", reason: "Clear bounded homepage improvement.", question: "", decision_key: null,
    dependencies: [], executor: "codex", runtime: "local", shipping_policy: "deploy", should_decompose: false,
    work_items: [{
      title: "Improve the homepage hero/header",
      outcome: "Improve homepage message hierarchy and CTA clarity without changing positioning or other pages.",
      acceptance_criteria: [
        { description: "Homepage hero/header only; preserve the design system and accessibility.", verification_ids: [] },
        { description: "Tests pass.", verification_ids: ["tests"] },
        { description: "Production build passes.", verification_ids: ["build"] },
        { description: "Ship to Netlify preview only with a URL and summary.", verification_ids: [] },
      ],
    }],
    ...overrides,
  };
}

const inclusionProject = {
  id: "inclusion", status: "active", executor: { kind: "codex" }, runtime: "local",
  verification: [{ id: "tests" }, { id: "build" }],
  deployment: { environment: "preview" },
  policy: { project_confidence: 0.9, execution_confidence: 0.9, allow_autonomous: true, approval_required: false, shipping: "deploy" },
  agent: { default_role: "auto", allowed_roles: ["general", "designer"] },
};

test("decision: Inclusion-like clear design brief infers routine criteria and routes Ready", () => {
  const item = { input: { text: "Homepage hero/header only. Improve clarity, hierarchy, CTA and visual treatment. Preserve positioning, design system, accessibility and performance. Tests and production build pass. Netlify preview only." } };
  const proposed = inclusionDecision({ work_items: [{
    title: "Improve the homepage hero/header",
    outcome: "Produce one clearly improved homepage hero/header within the stated constraints.",
    acceptance_criteria: [],
  }] });
  const prepared = inferRoutineAcceptanceCriteria(proposed, inclusionProject, item, "designer");
  assert.equal(routeDecision(prepared, [inclusionProject], "inclusion").state, "Ready");
  assert.deepEqual(new Set(prepared.work_items[0].acceptance_criteria.flatMap((criterion) => criterion.verification_ids)), new Set(["tests", "build"]));
  assert.match(prepared.work_items[0].acceptance_criteria.map((criterion) => criterion.description).join("\n"), /preview|configured.*deployment/i);
  assert.match(prepared.work_items[0].acceptance_criteria.map((criterion) => criterion.description).join("\n"), /desktop and mobile browser renders/i);
});

test("decision: genuine product ambiguity still requires clarification and invalid check IDs do not bypass readiness", () => {
  const unclear = inclusionDecision({ project_confidence: 0.3, execution_confidence: 0.4, sufficient_context: false, decision: "clarify", question: "Which positioning should the homepage lead with?", decision_key: "homepage-positioning", work_items: [] });
  assert.equal(routeDecision(inferRoutineAcceptanceCriteria(unclear, inclusionProject, { input: { text: "Redesign it" } }, "designer"), [inclusionProject], "inclusion").state, "Needs Clarification");
  const invalid = inclusionDecision();
  invalid.work_items[0].acceptance_criteria.push({ description: "Run an unavailable check.", verification_ids: ["made-up"] });
  assert.equal(routeDecision(inferRoutineAcceptanceCriteria(invalid, inclusionProject, { input: { text: "Clear" } }, "designer"), [inclusionProject], "inclusion").state, "Needs Clarification");
});

test("roles: design-heavy work routes to Designer, generic work stays general, and project override wins", () => {
  assert.equal(inferAgentRole({ item: { input: { text: "Polish the responsive homepage hero and CTA hierarchy" } }, decision: inclusionDecision(), project: inclusionProject }), "designer");
  assert.equal(inferAgentRole({ item: { input: { text: "Fix database retry handling" } }, decision: inclusionDecision({ work_items: [{ title: "Fix retry handling", outcome: "Retries are reliable.", acceptance_criteria: [] }] }), project: inclusionProject }), "general");
  assert.equal(inferAgentRole({ item: { input: { text: "Redesign the hero" } }, decision: inclusionDecision(), project: { ...inclusionProject, agent: { default_role: "general", allowed_roles: ["general", "designer"] } } }), "general");
});

test("roles: Designer composes inspectable built-in and project skills within bounds", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-role-"));
  fs.writeFileSync(path.join(repository, "PROJECT-DESIGN.md"), "# Project design skill\nUse the house component library.\n");
  const profile = composeAgentRole("designer", { repository, agent: { skill_sources: { designer: ["PROJECT-DESIGN.md"] } } });
  assert.equal(profile.id, "designer");
  assert.ok(profile.skills.length >= 7);
  assert.ok(profile.skills.some((skill) => skill.source === "PROJECT-DESIGN.md"));
  assert.match(profile.skills.map((skill) => skill.text).join("\n"), /generic stock metaphors/);
  assert.ok(profile.required_evidence.includes("desktop-visual-review"));
});

test("context: role-specific project context is bounded and excludes unrelated files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-context-"));
  fs.mkdirSync(path.join(root, "repo"));
  fs.writeFileSync(path.join(root, "repo", "README.md"), "base");
  fs.writeFileSync(path.join(root, "repo", "DESIGN.md"), "design context");
  fs.writeFileSync(path.join(root, "repo", "UNRELATED.md"), "do not load");
  const config = validateWorkflowConfig({ projects: [{
    id: "bounded", name: "Bounded", purpose: "Test", success_state: "Done", status: "active", repository: "repo",
    context_sources: ["README.md"], agent: { context_sources: { designer: ["DESIGN.md"] } },
    context_limits: { max_files: 2, max_file_bytes: 100, max_total_bytes: 100 },
    verification: [{ id: "tests", command: [process.execPath, "-e", "process.exit(0)"] }],
  }] }, path.join(root, "projects.yaml"));
  const context = projectContext(config.projects[0], { role: "designer" });
  assert.deepEqual(context.context.map((source) => source.source), ["README.md", "DESIGN.md"]);
  config.projects[0].context_limits.max_files = 1;
  assert.throws(() => projectContext(config.projects[0], { role: "designer" }), /exceeds 1 files/);
});

test("verification: Designer evidence separates automated checks from visual review", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-evidence-"));
  const project = { timeout_ms: 10_000, verification: [{
    id: "browser-qa", command: [process.execPath, "-e", "process.exit(0)"], roles: ["designer"],
    evidence_ids: ["browser-render", "no-obvious-overflow"],
  }] };
  const job = { agent_role: "designer", project_context: { agent_profile: { required_evidence: ["browser-render", "no-obvious-overflow", "desktop-visual-review", "mobile-visual-review"] } } };
  const execution = { report: { evidence: [
    { id: "desktop-visual-review", passed: true, summary: "Inspected the desktop composition.", artifacts: ["desktop.png"] },
    { id: "mobile-visual-review", passed: true, summary: "Inspected the mobile composition.", artifacts: ["mobile.png"] },
  ] } };
  const result = await new CommandVerifier().verify({ project, job, workspace: directory, commit: "abc", execution, directory: path.join(directory, "evidence") });
  assert.equal(result.passed, true);
  assert.equal(result.checks.find((check) => check.id === "role:browser-render").source, "automated");
  assert.equal(result.checks.find((check) => check.id === "role:desktop-visual-review").source, "agent_review");
});

test("verification: generic autonomous work keeps the command-only path", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-generic-"));
  const result = await new CommandVerifier().verify({
    project: { timeout_ms: 10_000, verification: [{ id: "tests", command: [process.execPath, "-e", "process.exit(0)"] }] },
    job: { agent_role: "general", project_context: { agent_profile: { required_evidence: [] } } },
    workspace: directory, commit: "abc", execution: { report: null }, directory: path.join(directory, "evidence"),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.checks.map((check) => check.id), ["tests"]);
});

test("persistence: inferred Designer role, composed skills, and superseded question survive restart", async () => {
  const h = harness();
  const item = h.submit("Improve the responsive homepage hero visual hierarchy and CTA");
  h.store.change((data) => {
    const current = data.items[item.id];
    h.store.move(data, current, "Decision", "Old evaluation.");
    h.store.move(data, current, "Needs Clarification", "Routine acceptance mapping was missing.");
    current.questions.push({ id: "old-question", decision_id: "old-decision", decision_key: "implicit:old", item_id: item.id, item_revision: current.revision, revision: 1, kind: "clarification", prompt: "Map acceptance criteria.", status: "open", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  });
  const revision = h.store.read().items[item.id].revision;
  await h.engine.reconsider(item.id, "capability-update", revision);
  const restarted = new Store(h.store.directory).read();
  assert.equal(restarted.items[item.id].state, "Ready");
  assert.equal(restarted.items[item.id].questions[0].status, "superseded");
  assert.equal(restarted.items[item.id].agent_role, "designer");
  const job = restarted.jobs[restarted.items[item.id].job_ids[0]];
  assert.equal(job.agent_role, "designer");
  assert.ok(job.project_context.agent_profile.skills.length > 0);
});
