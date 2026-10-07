import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { applyRemoteCommand, dashboardProjection, remoteCommand, watchRemoteCommands } from "../src/workflow/relay.js";
import { harness } from "./support/harness.js";

const assetId = "123e4567-e89b-42d3-a456-426614174000";
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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

test("relay: remote intake downloads verified assets into private state and projects safe preview metadata", async () => {
  const h = harness();
  const calls = [];
  const command = remoteCommand("intake", {
    content: "Use the attached reference image",
    project_hint: "example",
    assets: [{ id: assetId, filename: "reference.png", mime_type: "image/png", size: png.length, sha256: sha256(png) }],
  });
  const result = await applyRemoteCommand({
    store: h.store,
    config: h.config,
    command,
    assetBaseUrl: "https://roundhouse.example/api/assets",
    assetBearerToken: "dedicated-test-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url: url.href, options });
      return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://roundhouse.example/api/assets/${assetId}`);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers.authorization, "Bearer dedicated-test-secret");
  const item = h.store.read().items[result.item_id];
  assert.equal(item.input.attachments.length, 1);
  assert.equal(item.input.attachments[0].sha256, sha256(png));
  assert.equal(fs.readFileSync(item.input.attachments[0].path).toString("hex"), png.toString("hex"));
  assert.equal(fs.statSync(item.input.attachments[0].path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${h.store.directory}/assets`).mode & 0o777, 0o700);
  assert.doesNotMatch(JSON.stringify(h.store.read()), /dedicated-test-secret/);

  const projected = dashboardProjection(h.store.read(), h.config).overview.items[0].attachments[0];
  assert.deepEqual(projected, {
    id: assetId,
    filename: "reference.png",
    mime_type: "image/png",
    size: png.length,
    sha256: sha256(png),
    thumbnail_url: `https://roundhouse.example/api/assets/${assetId}/thumbnail`,
  });
  assert.equal(Object.hasOwn(projected, "path"), false);
});

test("relay: text-only remote intake remains asset-configuration independent", async () => {
  const h = harness();
  let fetched = false;
  const result = await applyRemoteCommand({
    store: h.store,
    config: h.config,
    command: remoteCommand("intake", { content: "Text only", project_hint: "example" }),
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
    assetBaseUrl: undefined,
    assetBearerToken: undefined,
  });
  assert.equal(fetched, false);
  assert.equal(h.store.read().items[result.item_id].input.attachments, undefined);
});

test("relay: a rejected intake removes assets downloaded for that submission", async () => {
  const h = harness();
  await assert.rejects(() => applyRemoteCommand({
    store: h.store,
    config: h.config,
    command: remoteCommand("intake", { content: "", assets: [{ id: assetId, filename: "reference.png", mime_type: "image/png", size: png.length }] }),
    assetBaseUrl: "https://roundhouse.example/api/assets/",
    assetBearerToken: "token",
    fetchImpl: async () => new Response(png, { headers: { "content-type": "image/png" } }),
  }), /nonempty text/);
  assert.deepEqual(h.store.read().items, {});
  assert.equal(fs.readdirSync(`${h.store.directory}/assets`).length, 0);
});

test("relay: asset intake fails closed before fetch for missing credentials and unsafe descriptors", async () => {
  const cases = [
    { assets: [{ id: assetId, filename: "reference.png", mime_type: "image/png", size: png.length }], token: undefined, match: /BEARER_TOKEN/ },
    { assets: [{ id: "not-a-uuid", filename: "reference.png", mime_type: "image/png", size: png.length }], token: "token", match: /canonical UUID/ },
    { assets: [{ id: assetId, filename: "../reference.png", mime_type: "image/png", size: png.length }], token: "token", match: /filename is unsafe/ },
    { assets: [{ id: assetId, filename: "reference.svg", mime_type: "image/svg+xml", size: png.length }], token: "token", match: /unsupported/ },
    { assets: [{ id: assetId, filename: "reference.png", mime_type: "image/png", size: png.length, url: "https://evil.example/file" }], token: "token", match: /Unsupported remote asset field/ },
  ];
  for (const [index, fixture] of cases.entries()) {
    const h = harness();
    let fetched = false;
    await assert.rejects(() => applyRemoteCommand({
      store: h.store,
      config: h.config,
      command: remoteCommand("intake", { content: `Rejected ${index}`, assets: fixture.assets }),
      assetBaseUrl: "https://roundhouse.example/api/assets/",
      assetBearerToken: fixture.token,
      fetchImpl: async () => { fetched = true; return new Response(png); },
    }), fixture.match);
    assert.equal(fetched, false);
    assert.deepEqual(h.store.read().items, {});
  }
});

test("relay: asset intake rejects redirects and response integrity failures without persisting state", async (t) => {
  const fixtures = [
    { name: "redirect", response: () => new Response(null, { status: 302, headers: { location: "https://evil.example/file" } }), match: /redirect denied/ },
    { name: "MIME", response: () => new Response(png, { headers: { "content-type": "application/pdf" } }), match: /MIME mismatch/ },
    { name: "signature", response: () => new Response(Buffer.alloc(png.length), { headers: { "content-type": "image/png" } }), match: /signature mismatch/ },
    { name: "size", response: () => new Response(png.subarray(0, png.length - 1), { headers: { "content-type": "image/png" } }), match: /size does not match/ },
    { name: "SHA-256", response: () => new Response(png, { headers: { "content-type": "image/png" } }), hash: "0".repeat(64), match: /SHA-256 mismatch/ },
  ];
  for (const fixture of fixtures) await t.test(fixture.name, async () => {
    const h = harness();
    await assert.rejects(() => applyRemoteCommand({
      store: h.store,
      config: h.config,
      command: remoteCommand("intake", { content: "Reject bad response", assets: [{
        id: assetId, filename: "reference.png", mime_type: "image/png", size: png.length,
        ...(fixture.hash ? { sha256: fixture.hash } : {}),
      }] }),
      assetBaseUrl: "https://roundhouse.example/api/assets/",
      assetBearerToken: "token",
      fetchImpl: async () => fixture.response(),
    }), fixture.match);
    assert.deepEqual(h.store.read().items, {});
    assert.equal(fs.readdirSync(`${h.store.directory}/assets`).length, 0);
  });
});

test("relay: refinement sessions accept only the current single question", async () => {
  const h = harness();
  const item = h.submit("ambiguous idea");
  const decided = await h.engine.run();
  const question = decided.items[item.id].refinement.active_question;
  await assert.rejects(() => applyRemoteCommand({
    store: h.store, config: h.config,
    command: remoteCommand("decision_session", { item_id: item.id, answers: [
      { question_id: question.id, answer: "First" },
      { question_id: question.id, answer: "Second" },
    ] }),
  }), /exactly one/);
  await applyRemoteCommand({
    store: h.store, config: h.config,
    command: remoteCommand("decision_session", { item_id: item.id, project_id: "example", answers: [
      { question_id: question.id, answer: "Append a feature entry" },
    ] }),
  });
  const updated = h.store.read().items[item.id];
  assert.equal(updated.clarifications.length, 1);
  assert.equal(updated.refinement.active_question, null);
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
