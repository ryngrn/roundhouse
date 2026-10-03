import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appendBriefRevision, createCapture, evaluateBriefReadiness, loadCapture, loadProjects, saveCapture } from "../src/intake.js";

const projects = loadProjects(new URL("../config/intake-projects.example.yaml", import.meta.url));
const input = { text: "  Roundhouse idea\nOriginal wording.  ", actor: "operator", source: "chat:test" };
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-intake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("capture survives reload with original words and immutable context snapshot", (t) => {
  const dir = temporary(t);
  const record = createCapture({ ...input, project_id: "roundhouse", metric_keys: ["slice_ready_rate"] }, projects);
  const files = saveCapture(dir, record);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.intake_file, "utf8")), record.intake);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.brief_file, "utf8")), record.brief);
  assert.deepEqual(loadCapture(dir, record.intake.id).brief, record.brief);
  assert.equal(record.intake.text, input.text);
  assert.equal(record.brief.project_context.weight, 1);
  assert.equal(record.brief.project_context.max_concurrent_runs, 1);
  assert.equal(record.brief.status, "draft");
  record.intake.text = "overwrite attempt";
  assert.throws(() => saveCapture(dir, record), /Intake already exists/);
  assert.equal(loadCapture(dir, record.intake.id).intake.text, input.text);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("Brief revisions append separately without changing the original Intake", (t) => {
  const dir = temporary(t);
  const record = createCapture({ ...input, project_id: "roundhouse" }, projects);
  saveCapture(dir, record);
  const revision = appendBriefRevision(dir, record.intake.id, { outcome: "A refined outcome." });
  const reloaded = loadCapture(dir, record.intake.id);
  assert.equal(revision.revision, 2);
  assert.equal(reloaded.brief.outcome, "A refined outcome.");
  assert.deepEqual(reloaded.brief_revisions.map((brief) => brief.revision), [1, 2]);
  assert.equal(reloaded.brief_revisions[0].outcome, null);
  assert.equal(reloaded.intake.text, input.text);
  assert.deepEqual(fs.readdirSync(path.join(dir, record.intake.id, "briefs")), ["000001.json", "000002.json"]);
  assert.throws(() => appendBriefRevision(dir, record.intake.id, { project_id: "family-history" }), /cannot be revised directly/);
});

test("Brief readiness requires revision-bound material inputs and never grants execution authority", (t) => {
  const dir = temporary(t);
  const configured = structuredClone(projects);
  configured[0].required_design_artifacts = ["desktop-flow", "mobile-flow"];
  const record = createCapture({ ...input, project_id: "roundhouse" }, configured);
  saveCapture(dir, record);

  assert.equal(record.brief.readiness.ready, false);
  assert.equal(record.brief.execution_eligible, false);
  assert.deepEqual(record.brief.readiness.reasons.map((reason) => reason.code), [
    "missing_outcome", "missing_scope", "missing_acceptance_criteria", "missing_approval", "missing_design_artifacts",
  ]);

  const ready = appendBriefRevision(dir, record.intake.id, {
    outcome: "One coherent revision-bound slice is available for downstream review.",
    scope: "Only define and persist Brief readiness; do not dispatch or execute work.",
    acceptance_criteria: ["Material inputs are complete and bound to this Brief revision."],
    decision_references: [{ id: "decision.scope", brief_revision: 2 }],
    design_artifacts: [
      { id: "desktop-flow", brief_revision: 2, uri: "artifact://desktop-flow-v2" },
      { id: "mobile-flow", brief_revision: 2, uri: "artifact://mobile-flow-v2" },
    ],
    approval: { brief_revision: 2, actor: "operator", approved_at: "2026-10-03T12:00:00.000Z" },
  });
  assert.equal(ready.status, "slice_ready");
  assert.deepEqual(ready.readiness, { ready: true, evaluated_revision: 2, reasons: [] });
  assert.equal(ready.execution_eligible, false);
  assert.deepEqual(ready.decision_ids, ["decision.scope"]);

  const changed = appendBriefRevision(dir, record.intake.id, { scope: "The scope changed after approval." });
  assert.equal(changed.status, "draft");
  assert.equal(changed.execution_eligible, false);
  assert.deepEqual(changed.readiness.reasons.map((reason) => reason.code), [
    "stale_decision_references", "stale_approval", "stale_design_artifacts",
  ]);
  assert.match(changed.readiness.reasons[1].message, /revision 2.*current revision 3/);

  const persisted = loadCapture(dir, record.intake.id);
  assert.deepEqual(persisted.brief.readiness, evaluateBriefReadiness(persisted.brief));
  assert.deepEqual(persisted.brief_revisions.map((brief) => brief.status), ["draft", "slice_ready", "draft"]);
});

test("slice-ready status cannot be asserted without matching derived readiness", (t) => {
  const record = createCapture({ ...input, project_id: "roundhouse" }, projects);
  const { brief } = record;
  assert.equal(brief.status, "draft");
  assert.deepEqual(brief.readiness.reasons.map((reason) => reason.code), [
    "missing_outcome", "missing_scope", "missing_acceptance_criteria", "missing_approval",
  ]);
  brief.status = "slice_ready";
  assert.throws(() => saveCapture(temporary(t), record), /status must match readiness/);
});

test("inactive project context and malformed revision-bound inputs cannot become ready", () => {
  const paused = structuredClone(projects);
  paused[0].status = "paused";
  const inactive = createCapture({
    ...input, project_id: "roundhouse", outcome: "A bounded outcome.", scope: "One slice.",
    acceptance_criteria: ["The outcome is observable."],
    approval: { brief_revision: 1, actor: "operator", approved_at: "2026-10-03T12:00:00.000Z" },
  }, paused).brief;
  assert.deepEqual(inactive.readiness.reasons.map((reason) => reason.code), ["inactive_project_context"]);
  assert.equal(inactive.status, "draft");
  assert.throws(() => createCapture({
    ...input, project_id: "roundhouse", decision_references: [{ id: "scope decision", brief_revision: 1 }],
  }, projects), /decision references are invalid/);
  assert.throws(() => createCapture({
    ...input, project_id: "roundhouse", approval: { brief_revision: 1, actor: "operator", approved_at: "not-a-date" },
  }, projects), /approval is invalid/);
});

test("explicit selection wins; inference is conservative and permits repository-free work", () => {
  const repositoryFree = createCapture({ ...input, project_id: "family-history" }, projects).brief;
  assert.equal(repositoryFree.project_id, "family-history");
  assert.equal(repositoryFree.project_context.repository, undefined);
  const inferred = createCapture(input, projects).brief;
  assert.equal(inferred.project_id, "roundhouse");
  assert.ok(inferred.project_context.purpose);
  assert.ok(inferred.project_context.success_state);
  for (const text of ["Something new", "Roundhouse and Family History", "NotRoundhouse"]) {
    const brief = createCapture({ ...input, text }, projects).brief;
    assert.equal(brief.project_id, null);
    assert.equal(brief.status, "needs_clarification");
    assert.ok(brief.clarification);
    assert.match(brief.classification.rationale, /human clarification required/);
  }
});

test("ambiguous inference persists its visible assignment reason", (t) => {
  const dir = temporary(t);
  const record = createCapture({ ...input, text: "Roundhouse and Family History" }, projects);
  saveCapture(dir, record);
  const reloaded = loadCapture(dir, record.intake.id);
  assert.equal(reloaded.brief.project_id, null);
  assert.equal(reloaded.brief.status, "needs_clarification");
  assert.deepEqual(reloaded.brief.classification.candidate_ids, ["roundhouse", "family-history"]);
  assert.match(reloaded.brief.classification.rationale, /human clarification required/);
  assert.equal(reloaded.brief.clarification, "Which project should this idea belong to?");
});

test("invalid inputs and metric references fail before persistence", () => {
  for (const value of [null, [], { ...input, text: " " }, { ...input, actor: "" }, { ...input, project_id: "missing" }, { ...input, metric_keys: ["unknown"] }, { ...input, metric_keys: ["bad-key"] }, { ...input, metric_keys: ["slice_ready_rate", "slice_ready_rate"], project_id: "roundhouse" }, { ...input, metric_keys: "bad" }]) {
    assert.throws(() => createCapture(value, projects));
  }
  assert.throws(() => createCapture({ ...input, project_id: "roundhouse", metric_keys: ["unknown"] }, projects), /Unknown metric reference for project roundhouse: unknown/);
});

test("malformed project manifests fail clearly", (t) => {
  const file = path.join(temporary(t), "manifest.json");
  for (const changes of [{ weight: 0 }, { max_concurrent_runs: 1.5 }, { status: "unknown" }, { purpose: "" }, { metric_definitions: [{ key: "bad" }] }]) {
    fs.writeFileSync(file, JSON.stringify({ projects: [{ ...projects[0], ...changes }] }));
    assert.throws(() => loadProjects(file));
  }
});

test("CLI captures and reloads a complete record; malformed requests produce no files", (t) => {
  const dir = temporary(t);
  const root = path.resolve(import.meta.dirname, "..");
  const args = ["src/cli.js", "capture", "--input", "config/intake.example.json", "--manifest", "config/intake-projects.example.yaml", "--state-dir", dir];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(result.stdout);
  const persisted = loadCapture(path.join(dir, "intakes"), event.intake_id);
  assert.equal(persisted.intake.id, event.intake_id);
  assert.equal(persisted.brief.project_id, "roundhouse");
  assert.equal(persisted.brief.metric_keys[0], "slice_ready_rate");
  const bad = spawnSync(process.execPath, [...args, "--unknown", "x"], { cwd: root, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Invalid capture option/);
  const malformedInput = path.join(dir, "malformed.json");
  fs.writeFileSync(malformedInput, "{not-json");
  const malformed = spawnSync(process.execPath, args.with(3, malformedInput), { cwd: root, encoding: "utf8" });
  assert.notEqual(malformed.status, 0);
  assert.ok(malformed.stderr.trim());
  assert.equal(fs.readdirSync(path.join(dir, "intakes")).length, 1);
  assert.equal(event.brief_file, path.join(dir, "intakes", event.intake_id, "briefs", "000001.json"));
});
