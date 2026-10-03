import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadCapture } from "../src/intake.js";

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
  assert.equal(persisted.brief.project_context.purpose, "Help one operator advance meaningful work across projects.");
  assert.equal(persisted.brief.project_context.success_state, "Ideas become coherent executable slices with minimal manual coordination.");
  assert.equal(persisted.brief.metrics[0].key, "slice_ready_rate");
  assert.deepEqual(fs.readdirSync(path.dirname(event.brief_file)), ["000001.json"]);
});
