import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Engine } from "../src/workflow/engine.js";
import { harness } from "./support/harness.js";

function enableDurableShared(h) {
  const store = h.store;
  const activeLeases = new Map();
  const receipts = new Map();
  store.shared = true;
  store.kind = "postgresql";
  store.leaseMs = 60_000;
  store.node = { id: randomUUID(), name: "cloud-decision-node" };
  h.config.decision = { ...(h.config.decision ?? {}), durable_attempts: true };
  store.acquireLease = async (kind, key) => {
    const identity = `${kind}/${key}`;
    if (activeLeases.has(identity)) return null;
    const lease = { resource_kind: kind, resource_key: key, token: randomUUID() };
    activeLeases.set(identity, lease.token);
    return lease;
  };
  store.releaseLease = async (lease) => {
    const key = `${lease.resource_kind}/${lease.resource_key}`;
    if (activeLeases.get(key) === lease.token) activeLeases.delete(key);
  };
  store.assertLease = async (lease) => {
    if (activeLeases.get(`${lease.resource_kind}/${lease.resource_key}`) !== lease.token)
      throw new Error("Lease lost");
  };
  store.heartbeatNode = async () => {};
  store.recoverExpiredClaims = async () => 0;
  store.startDecisionAttempt = async (id, lease) => {
    await store.assertLease(lease);
    const item = store.read().items[id];
    assert.equal(item.state, "Decision");
    const receipt = { id: randomUUID(), item_id: id, token: randomUUID(), start_revision: item.revision, status: "running" };
    receipts.set(receipt.id, receipt);
    return receipt;
  };
  const originalChange = store.change.bind(store);
  store.change = (fn, options = {}) => {
    if (options.decisionAttempt) {
      const receipt = receipts.get(options.decisionAttempt.id);
      assert.equal(receipt?.status, "running");
      assert.equal(receipt.token, options.decisionAttempt.token);
      assert.equal(store.read().items[receipt.item_id].revision, receipt.start_revision);
      assert.equal(store.read().items[receipt.item_id].state, "Decision");
    }
    const result = originalChange(fn);
    if (options.decisionOutcome) receipts.get(options.decisionAttempt.id).status = options.decisionOutcome;
    return result;
  };
  return { activeLeases, receipts };
}

function decision(project) {
  return {
    project: project.id, project_confidence: 0.99, execution_confidence: 0.99,
    sufficient_context: true, safe_to_execute: true, approval_required: false,
    decision: "execute", reason: "Small, approved slice.", questions: [], dependencies: [],
    executor: project.executor.kind, runtime: project.runtime, shipping_policy: project.policy.shipping,
    should_decompose: false,
    work_items: [{ title: "Cloud-native slice", outcome: "Verified bounded output", acceptance_criteria: [] }],
  };
}

test("cloud-native triage releases the item lease before a model call and fences its result", async () => {
  const h = harness();
  const submitted = h.submit("cloud decision receipt");
  const { activeLeases, receipts } = enableDurableShared(h);
  let sawReleased = false;
  const engine = new Engine({ store: h.store, config: h.config,
    decision: { decide: async ({ projects, onStart }) => {
      sawReleased = activeLeases.size === 0;
      await onStart(12345);
      return decision(projects[0]);
    } },
  });
  await engine.runTriage();
  assert.equal(sawReleased, true);
  assert.equal(h.store.read().items[submitted.id].state, "Ready");
  assert.equal([...receipts.values()][0].status, "completed");
  assert.equal(h.store.read().items[submitted.id].triage.attempts.length, 1);
});

test("failed cloud decision is quarantined once, without implicit model retry", async () => {
  const h = harness();
  const submitted = h.submit("provider fails after claim");
  const { receipts } = enableDurableShared(h);
  let calls = 0;
  const engine = new Engine({ store: h.store, config: h.config,
    decision: { decide: async () => { calls += 1; throw new Error("provider unavailable"); } },
  });
  await engine.runTriage();
  await engine.runTriage();
  const item = h.store.read().items[submitted.id];
  assert.equal(item.state, "Blocked");
  assert.equal(item.triage.interrupted, true);
  assert.equal(calls, 1);
  assert.equal([...receipts.values()][0].status, "failed");
  assert.equal(Object.keys(h.store.read().jobs).length, 0);
});
