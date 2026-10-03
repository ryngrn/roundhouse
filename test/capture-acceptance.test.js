import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appendBriefRevision, createCapture, loadCapture, loadProjects, saveCapture } from "../src/intake.js";

test("acceptance: CLI capture persists a reloadable Intake and versioned Brief", (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-capture-acceptance-"));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const root = path.resolve(import.meta.dirname, "..");
  const result = spawnSync(process.execPath, [
    "src/cli.js", "capture",
    "--input", "config/intake.example.json",
    "--manifest", "config/intake-projects.example.yaml",
    "--state-dir", stateDirectory,
  ], { cwd: root, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(result.stdout);
  const persisted = loadCapture(path.join(stateDirectory, "intakes"), event.intake_id);
  assert.equal(persisted.intake.text, "Help Roundhouse preserve incoming ideas and their original wording.");
  assert.equal(persisted.brief.revision, 1);
  assert.equal(persisted.brief.material_revision, 1);
  assert.equal(persisted.brief.project_context.purpose, "Help one operator advance meaningful work across projects.");
  assert.equal(persisted.brief.project_context.success_state, "Ideas become coherent executable slices with minimal manual coordination.");
  assert.equal(persisted.brief.metrics[0].key, "slice_ready_rate");
  assert.deepEqual(fs.readdirSync(path.dirname(event.brief_file)), ["000001.json"]);
});

test("acceptance: material Brief edits invalidate approval without penalizing lifecycle updates", (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-capture-readiness-"));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const projects = loadProjects(new URL("../config/intake-projects.example.yaml", import.meta.url));
  const record = createCapture({
    text: "Define revision-aware Brief readiness.", actor: "operator", source: "acceptance:test", project_id: "roundhouse",
    outcome: "Readiness follows material content.", scope: "The capture Brief lifecycle only.",
    acceptance_criteria: ["Stale approval cannot authorize changed material content."],
    decision_references: [{ id: "decision.readiness", brief_revision: 1 }],
    approval: { brief_revision: 1, actor: "operator", approved_at: "2026-10-03T12:00:00.000Z" },
  }, projects);
  saveCapture(stateDirectory, record);

  const lifecycleUpdate = appendBriefRevision(stateDirectory, record.intake.id, {
    approval: { brief_revision: 1, actor: "reviewer", approved_at: "2026-10-03T13:00:00.000Z" },
  });
  assert.equal(lifecycleUpdate.readiness.ready, true);
  assert.equal(lifecycleUpdate.material_revision, 1);

  const materialUpdate = appendBriefRevision(stateDirectory, record.intake.id, { scope: "The revised capture Brief lifecycle only." });
  assert.equal(materialUpdate.readiness.ready, false);
  assert.equal(materialUpdate.material_revision, 2);
  assert.ok(materialUpdate.readiness.reasons.some((reason) => reason.code === "stale_approval"));
  assert.deepEqual(loadCapture(stateDirectory, record.intake.id).brief_revisions.map((brief) => brief.revision), [1, 2, 3]);
});
