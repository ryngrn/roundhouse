import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadProjects, createCapture, saveCapture } from "../src/intake.js";

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
  const file = saveCapture(dir, record);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), record);
  assert.equal(record.intake.text, input.text);
  assert.equal(record.brief.project_context.weight, 1);
  assert.equal(record.brief.project_context.max_concurrent_runs, 1);
  assert.equal(record.brief.status, "draft");
  record.intake.text = "overwrite attempt";
  assert.throws(() => saveCapture(dir, record), { code: "EEXIST" });
  assert.equal(JSON.parse(fs.readFileSync(file)).intake.text, input.text);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("explicit selection wins; inference is conservative and permits repository-free work", () => {
  assert.equal(createCapture({ ...input, project_id: "family-history" }, projects).brief.project_id, "family-history");
  assert.equal(createCapture(input, projects).brief.project_id, "roundhouse");
  for (const text of ["Something new", "Roundhouse and Family History", "NotRoundhouse"]) {
    const brief = createCapture({ ...input, text }, projects).brief;
    assert.equal(brief.project_id, null);
    assert.equal(brief.status, "needs_clarification");
    assert.ok(brief.clarification);
  }
});

test("invalid inputs and metric references fail before persistence", () => {
  for (const value of [null, [], { ...input, text: " " }, { ...input, actor: "" }, { ...input, project_id: "missing" }, { ...input, metric_keys: ["unknown"] }, { ...input, metric_keys: "bad" }]) {
    assert.throws(() => createCapture(value, projects));
  }
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
  const persisted = JSON.parse(fs.readFileSync(event.file));
  assert.equal(persisted.intake.id, event.intake_id);
  assert.equal(persisted.brief.project_id, "roundhouse");
  assert.equal(persisted.brief.metric_keys[0], "slice_ready_rate");
  const bad = spawnSync(process.execPath, [...args, "--unknown", "x"], { cwd: root, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Invalid capture option/);
  assert.equal(fs.readdirSync(path.join(dir, "intakes")).length, 1);
});
