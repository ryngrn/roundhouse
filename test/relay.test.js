import test from "node:test";
import assert from "node:assert/strict";
import { applyRemoteCommand, dashboardProjection, remoteCommand, watchRemoteCommands } from "../src/workflow/relay.js";
import { harness } from "./support/harness.js";

test("relay: project assignment updates local workflow state", async () => {
  const h = harness();
  const item = h.store.submit({ text: "Unassigned idea", source: "fixture", actor: "test" }, "unassigned");
  const result = await applyRemoteCommand({
    store: h.store,
    config: h.config,
    command: remoteCommand("project_assign", { item_id: item.id, expected_item_revision: item.revision, project_id: "example" }),
  });
  const updated = h.store.read().items[item.id];
  assert.equal(result.project_id, "example");
  assert.equal(updated.project_id, "example");
  assert.equal(updated.selected_project, "example");
  assert.equal(updated.revision, item.revision + 1);
});

test("relay: ready work can jump to the front of its project line", async () => {
  const h = harness();
  const first = h.submit("first job", "first-job");
  const second = h.submit("second job", "second-job");
  await h.engine.decide(first.id);
  await h.engine.decide(second.id);
  const before = h.store.read();
  const firstJob = before.jobs[first.job_ids?.[0] ?? before.items[first.id].job_ids[0]];
  const secondJob = before.jobs[before.items[second.id].job_ids[0]];
  assert.ok(firstJob.position < secondJob.position);
  await applyRemoteCommand({
    store: h.store,
    config: h.config,
    command: remoteCommand("jump_front", { item_id: secondJob.id, expected_item_revision: secondJob.revision }),
  });
  const after = h.store.read();
  assert.ok(after.jobs[secondJob.id].position < after.jobs[firstJob.id].position);
  assert.match(after.jobs[secondJob.id].history.at(-1).reason, /front/);
});

test("relay: dashboard projection exposes changed state for the web dashboard", async () => {
  const h = harness();
  const item = h.store.submit({ text: "Needs a project", source: "fixture", actor: "test" }, "needs-project");
  await applyRemoteCommand({
    store: h.store,
    config: h.config,
    command: remoteCommand("project_assign", { item_id: item.id, expected_item_revision: item.revision, project_id: "example" }),
  });
  const projection = dashboardProjection(h.store.read(), h.config);
  assert.equal(projection.configuration.projects[0].id, "example");
  assert.equal(projection.overview.items[0].project, "example");
  assert.equal(projection.overview.counts.queued, 1);
});

test("relay: wake watcher syncs once on startup and once per ntfy message", async () => {
  const h = harness();
  let syncs = 0;
  const seen = [];
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{\"event\":\"open\"}\n{\"event\":\"message\"}\n"));
      controller.close();
    },
  });
  const result = await watchRemoteCommands({
    store: h.store,
    config: h.config,
    subscribeUrl: "https://ntfy.sh/example/json",
    fetchImpl: async () => ({ ok: true, body: stream }),
    sync: async () => ({ syncs: ++syncs }),
    onSync: (value) => seen.push(value.syncs),
  });
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(result, { stopped: true });
});
