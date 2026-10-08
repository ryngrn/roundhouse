import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { RoundhouseService } from "../src/workflow/service.js";
import { Store } from "../src/workflow/store.js";
import { WorkerLoop } from "../src/server/worker.js";

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-project-model-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, "projects.yaml");
  fs.writeFileSync(configFile, YAML.stringify({ decision: { kind: "codex", bin: "codex" }, projects: [] }));
  return { directory, configFile, store: new Store(path.join(directory, "state")) };
}

test("legacy named candidates become ordinary project assignments while Unassigned stays null", async (t) => {
  const { configFile, store } = setup(t);
  const assigned = store.submit({ text: "Research the family archive", source: "fixture", actor: "test" }, "assigned");
  const unassigned = store.submit({ text: "Sort this later", source: "fixture", actor: "test" }, "unassigned");
  store.change((data) => {
    data.project_candidates = {
      family: { id: "family", name: "Family Legacy", source_system: "legacy" },
      none: { id: "none", name: "Unassigned", source_system: "legacy" },
    };
    data.items[assigned.id].project_candidate_id = "family";
    data.items[unassigned.id].project_candidate_id = "none";
  });
  const service = new RoundhouseService({ store, configFile });
  await service.initialize();
  const state = store.read();
  assert.equal(state.items[assigned.id].project_id, "family-legacy");
  assert.equal(state.items[assigned.id].project_candidate_id, undefined);
  assert.equal(state.projects["family-legacy"].name, "Family Legacy");
  assert.equal(state.items[unassigned.id].project_id ?? null, null);
  assert.equal(state.items[unassigned.id].project_candidate_id, undefined);
});

test("new project initiation creates a real repository-free project and assigns its first idea", async (t) => {
  const { configFile, store } = setup(t);
  const service = new RoundhouseService({ store, configFile });
  await service.initialize();
  const created = await service.initiateProject({
    name: "Family Legacy",
    outcome: "Research the family history and return useful source files.",
    trusted: true,
  });
  assert.equal(created.item.project, "family-legacy");
  assert.equal(created.project.name, "Family Legacy");
  const configuration = service.getConfiguration().configuration;
  const project = configuration.projects.find((entry) => entry.id === "family-legacy");
  assert.equal(project.repository_required, false);
  assert.equal(project.policy.shipping, "durable_output");
  assert.equal(project.policy.allow_autonomous, true);
});

test("Studio consumes hosted project creation, assignment, and priority commands", async () => {
  const commands = [
    { id: "create", kind: "project_create", payload: { name: "Family Legacy", purpose: "Research it" } },
    { id: "assign", kind: "project_assign", payload: { item_id: "item", expected_item_revision: 1, project_id: "family-legacy" } },
    { id: "front", kind: "jump_front", payload: { item_id: "item", expected_item_revision: 2 } },
  ];
  const calls = [];
  const finished = [];
  const worker = new WorkerLoop({
    service: {
      initiateProject: async (payload) => { calls.push(["create", payload]); return { ok: true }; },
      assignProject: async (payload) => { calls.push(["assign", payload]); return { ok: true }; },
      jumpToFront: async (payload) => { calls.push(["front", payload]); return { ok: true }; },
    },
    commandQueue: {
      claimRemoteCommand: async () => commands.shift() ?? null,
      finishRemoteCommand: async (id, outcome) => finished.push([id, outcome]),
    },
  });
  const result = await worker.remoteCommandTick();
  assert.equal(result.remote_commands, 3);
  assert.deepEqual(calls.map(([kind]) => kind), ["create", "assign", "front"]);
  assert.ok(finished.every(([, outcome]) => outcome.result?.ok === true));
});
