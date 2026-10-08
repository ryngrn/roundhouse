import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Engine } from "../src/workflow/engine.js";
import { exportFileDigest, importNotionDepot } from "../src/workflow/notion-depot-migration.js";
import { Store } from "../src/workflow/store.js";

const fixtureFile = path.resolve("test/fixtures/notion-depot-export.json");
const fixtureBytes = fs.readFileSync(fixtureFile);
const fixture = JSON.parse(fixtureBytes);
const configuredProjects = [{ id: "inclusion", name: "Inclusion" }];

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-notion-cutover-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new Store(directory) };
}

test("Notion Depot cutover imports safe history/pending records, assigns projects, preserves provenance and reconciles native IDs", (t) => {
  const { directory, store } = setup(t);
  const native = store.submit({ text: "Native work", source: "web", actor: "local-user" }, "native");
  const exported = structuredClone(fixture);
  exported.rows.at(-1)["Roundhouse Job ID"] = native.id;
  const bytes = Buffer.from(JSON.stringify(exported));
  const report = importNotionDepot({ store, exportData: exported, exportDigest: exportFileDigest(bytes), configuredProjects,
    now: () => "2026-10-02T12:00:00.000Z" });

  assert.deepEqual({ total: report.total, history: report.imported_history, pending: report.imported_pending, reconciled: report.reconciled,
    skipped: report.skipped_already_imported, conflicts: report.conflicts, errors: report.errors },
  { total: 6, history: 1, pending: 4, reconciled: 1, skipped: 0, conflicts: 0, errors: 0 });
  const state = store.read();
  const history = Object.values(state.items).find((item) => item.provenance?.source_id === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const inbox = Object.values(state.items).find((item) => item.provenance?.source_id === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const p0 = Object.values(state.items).find((item) => item.priority === "P0");
  assert.equal(history.state, "Imported History");
  assert.equal(history.created_at, "2025-01-02T03:04:05.000Z");
  assert.equal(history.legacy_depot.Outcome, "The historical improvement shipped.");
  assert.equal(inbox.state, "Imported Pending");
  assert.equal(inbox.execution_eligible, false);
  assert.equal(inbox.requires_reevaluation, true);
  assert.equal(inbox.legacy_depot["Decisions Needed"], "Choose audience before implementation");
  assert.equal(inbox.questions.length, 1);
  assert.equal(inbox.questions[0].kind, "imported_decision");
  assert.equal(inbox.project_id, "future-project");
  assert.equal(state.projects[inbox.project_id].name, "Future Project");
  assert.equal(state.projects[inbox.project_id].configured, false);
  assert.equal(inbox.project_candidate_id, undefined);
  assert.equal(p0.state, "Imported Pending");
  assert.equal(p0.priority_rank, 0);
  assert.equal(state.items[native.id].state, "Depot");
  assert.equal(state.items[native.id].legacy_sources[0].source_id, "ffffffffffffffffffffffffffffffff");
  assert.equal(state.system_metadata.notion_depot_cutover.completed, true);
  assert.equal(state.system_metadata.notion_depot_cutover.authoritative_system, "roundhouse");
  assert.equal(state.system_metadata.notion_depot_cutover.notion_mode, "archive_only");

  const restarted = new Store(directory).read();
  assert.equal(restarted.items[history.id].state, "Imported History");
  assert.equal(restarted.system_metadata.notion_depot_cutover.last_export_count, 6);
});

test("exact rerun is a no-op and a changed source record reports conflict without overwriting", (t) => {
  const { store } = setup(t);
  const exported = { rows: fixture.rows.slice(0, 2) };
  const bytes = Buffer.from(JSON.stringify(exported));
  const first = importNotionDepot({ store, exportData: exported, exportDigest: exportFileDigest(bytes), configuredProjects,
    now: () => "2026-10-02T12:00:00.000Z" });
  const stateBefore = JSON.stringify(store.read());
  const rerun = importNotionDepot({ store, exportData: exported, exportDigest: exportFileDigest(bytes), configuredProjects,
    now: () => "2026-10-03T12:00:00.000Z" });
  assert.equal(rerun.skipped_already_imported, 2);
  assert.equal(rerun.imported_history, 0);
  assert.equal(rerun.imported_pending, 0);
  assert.equal(JSON.stringify(store.read()), stateBefore);

  const changed = structuredClone(exported);
  changed.rows[0]["Raw Intake"] = "Changed after the cutover";
  const changedBytes = Buffer.from(JSON.stringify(changed));
  const conflict = importNotionDepot({ store, exportData: changed, exportDigest: exportFileDigest(changedBytes), configuredProjects,
    now: () => "2026-10-03T12:00:00.000Z" });
  assert.equal(conflict.conflicts, 1);
  assert.equal(conflict.skipped_already_imported, 1);
  assert.match(conflict.records.find((entry) => entry.action === "conflict").detail, /not overwritten/);
  const historical = Object.values(store.read().items).find((item) => item.provenance?.source_id === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(historical.input.text, "Ship the historical improvement");
  assert.equal(first.export_digest, exportFileDigest(bytes));
});

test("Ready and Running import labels trigger explicit triage but never direct worker execution", async (t) => {
  const { store } = setup(t);
  const exported = { rows: fixture.rows.slice(2, 4) };
  importNotionDepot({ store, exportData: exported, exportDigest: exportFileDigest(Buffer.from(JSON.stringify(exported))), configuredProjects });
  let decisions = 0;
  const engine = new Engine({
    store,
    config: { projects: [], max_jobs_per_run: 10 },
    decision: { decide: async () => { decisions += 1; throw new Error("triage fixture failure"); } },
  });
  const result = await engine.run();
  assert.equal(result.executed, 0);
  assert.equal(result.triaged, 2);
  assert.equal(decisions, 2);
  assert.deepEqual(Object.values(store.read().items).map((item) => item.state), ["Depot", "Depot"]);
  assert.ok(Object.values(store.read().items).every((item) => item.imported_release && item.execution_eligible === false));
  assert.equal(Object.keys(store.read().jobs).length, 0);
});

test("invalid rows are isolated and recorded in the cutover report", (t) => {
  const { store } = setup(t);
  const exported = { rows: [{ Item: "missing source" }, fixture.rows[0]] };
  const report = importNotionDepot({ store, exportData: exported, exportDigest: exportFileDigest(Buffer.from(JSON.stringify(exported))), configuredProjects });
  assert.equal(report.errors, 1);
  assert.equal(report.imported_history, 1);
  assert.equal(store.read().system_metadata.notion_depot_cutover.last_export_count, 2);
});

test("CLI exposes the one-time migration and reports an idempotent rerun", (t) => {
  const { directory } = setup(t);
  const stateDirectory = path.join(directory, "state");
  const args = ["src/cli.js", "migrate", "notion-depot", fixtureFile, "--state-dir", stateDirectory, "--config", path.join(directory, "missing.yaml")];
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual({ history: JSON.parse(first.stdout).imported_history, pending: JSON.parse(first.stdout).imported_pending }, { history: 1, pending: 5 });
  const before = fs.readFileSync(path.join(stateDirectory, "state.json"), "utf8");
  const second = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).skipped_already_imported, 6);
  assert.equal(fs.readFileSync(path.join(stateDirectory, "state.json"), "utf8"), before);
});
