import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/workflow/store.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { startRoundhouseServer } from "../src/server/app-server.js";
import { record } from "../src/workflow/state.js";
import { statusView } from "../src/workflow/views.js";

test("storage API projects authoritative health, stable node identity, and active job owner", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-storage-api-"));
  const store = new Store(directory, { env: { ROUNDHOUSE_NODE_NAME: "api-node", ROUNDHOUSE_NODE_CAPABILITIES: "execution" } });
  const item = store.submit({ text: "Owned work", source: "test", actor: "test" }, "owned-work");
  store.change((data) => {
    data.items[item.id].state = "Ready";
    data.items[item.id].job_ids = [`${item.id}-1`];
    data.jobs[`${item.id}-1`] = record(`${item.id}-1`, { state: "Executing", parent_id: item.id, project_id: "project",
      work: { title: "Owned job" }, dependencies: [], attempts: [], owning_node_id: store.node.id, owning_node: store.node.name });
  });
  const running = await startRoundhouseServer({ service: new RoundhouseService({ store }), port: 0, autoStartWorker: false });
  t.after(() => running.close());
  const health = await (await fetch(`${running.url}/health`)).json();
  assert.equal(health.storage.authoritative, true);
  assert.equal(health.storage.node.name, "api-node");
  const overview = await (await fetch(`${running.url}/api/overview`)).json();
  assert.equal(overview.connection.storage.kind, "local");
  assert.equal(overview.items[0].owning_node, "api-node");
  assert.equal(overview.counts.active, 1);
  assert.equal(overview.active_jobs.length, 1);
  assert.equal(overview.active_jobs[0].state, "Executing");
  assert.equal(overview.active_jobs[0].display_state, "Chugging along…");
  assert.equal(overview.active_jobs[0].runtime, "local");
  assert.equal(overview.active_jobs[0].remote_run_id, null);
  assert.equal("processes" in overview.active_jobs[0], false);
});

test("active job projection identifies machine-local Herdr work from durable metadata", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-herdr-status-"));
  const store = new Store(directory);
  const item = store.submit({ text: "Update Kmac", source: "test", actor: "test" }, "kmac-work");
  store.change((data) => {
    data.items[item.id].state = "Ready";
    data.items[item.id].project_id = "kmac";
    data.items[item.id].job_ids = [`${item.id}-1`];
    data.jobs[`${item.id}-1`] = record(`${item.id}-1`, {
      state: "Verification",
      parent_id: item.id,
      project_id: "kmac",
      work: { title: "Update Kmac" },
      project_context: {
        id: "kmac",
        runtime: "herdr",
        herdr: { machine: "iMac", agent: "roundhouse-imac", workspace_mode: "machine_local", working_directory: "/home/ryngrn/kmac" },
      },
      processes: [{ pid: 43210, at: "2026-10-04T00:00:00.000Z" }],
      attempts: [{
        number: 1,
        placement: { authority: { control_plane: "roundhouse", placement: "herdr" },
          selection: { machine: "iMac", platform: "macos", tool: "claude", agent: "roundhouse-imac",
            matched_capabilities: ["repository"], rationale: "Selected by Herdr.", source: "herdr_scheduler" } },
        execution: { remote_execution: {
          runtime: "herdr",
          machine_selector: "iMac",
          agent_target: "roundhouse-imac",
          workspace_mode: "machine_local",
          working_directory: "/home/ryngrn/kmac",
          execution_id: "remote-run-42",
          phase: "completed",
        } },
      }],
    });
  });
  const status = statusView(store.read());
  assert.equal(status.active_jobs.length, 1);
  assert.deepEqual({
    project: status.active_jobs[0].project,
    machine: status.active_jobs[0].machine,
    agent: status.active_jobs[0].agent,
    workspace_mode: status.active_jobs[0].workspace_mode,
    working_directory: status.active_jobs[0].working_directory,
    remote_run_id: status.active_jobs[0].remote_run_id,
  }, {
    project: "kmac",
    machine: "iMac",
    agent: "roundhouse-imac",
    workspace_mode: "machine_local",
    working_directory: "/home/ryngrn/kmac",
    remote_run_id: "remote-run-42",
  });
  assert.equal(status.active_jobs[0].remote_execution.execution_id, "remote-run-42");
  assert.equal(status.active_jobs[0].placement.selection.platform, "macos");
  assert.equal(status.items[0].jobs[0].placement.selection.source, "herdr_scheduler");
  assert.notEqual(status.active_jobs[0].remote_run_id, 43210);
  assert.equal(status.items[0].jobs[0].working_directory, "/home/ryngrn/kmac");
});
