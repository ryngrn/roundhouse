import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/workflow/store.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { startRoundhouseServer } from "../src/server/app-server.js";
import { record } from "../src/workflow/state.js";

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
});
