import test from "node:test";
import assert from "node:assert/strict";
import { cloudControlPlaneTick } from "../src/server/cloud-control-plane.js";

function fixture({ healthy = true } = {}) {
  const calls = [];
  const store = {
    kind: "postgresql", shared: true,
    status: async () => {
      calls.push("status");
      return { kind: "postgresql", shared: true, authoritative: true, connected: healthy, read_only: !healthy };
    },
    recordDueSchedules: async ({ limit }) => { calls.push(["due", limit]); return [{ id: "due-1" }]; },
    recoverExpiredClaims: async () => { calls.push("recover"); return 2; },
  };
  return { store, calls };
}

test("headless cloud control plane checks authority without touching work by default", async () => {
  const { store, calls } = fixture();
  const result = await cloudControlPlaneTick({ store });
  assert.deepEqual(calls, ["status"]);
  assert.deepEqual(result, { authority: "postgresql", schedules_due: 0, recovered: 0, remote_commands: 0, triaged: 0 });
});

test("headless tick fails closed on local state or disconnected authority", async () => {
  await assert.rejects(cloudControlPlaneTick({ store: { shared: false, status: async () => ({ kind: "local" }) } }), /shared PostgreSQL/);
  await assert.rejects(cloudControlPlaneTick({ store: fixture({ healthy: false }).store }), /connected, writable/);
  await assert.rejects(cloudControlPlaneTick({ store: fixture().store, maxDue: 11 }), /Due limit/);
  await assert.rejects(cloudControlPlaneTick({ store: fixture().store, maxCommands: 0 }), /Command limit/);
});

test("headless tick explicitly records bounded due events and safely recovers expired claims", async () => {
  const { store, calls } = fixture();
  const result = await cloudControlPlaneTick({ store, recordSchedules: true, recover: true, maxDue: 3 });
  assert.equal(result.schedules_due, 1);
  assert.equal(result.recovered, 2);
  assert.deepEqual(calls, ["status", ["due", 3], "recover"]);
});

test("headless tick will not process commands or decisions without guarded service", async () => {
  const { store } = fixture();
  await assert.rejects(cloudControlPlaneTick({ store, handleCommands: true }), /guarded service and relay/);
  await assert.rejects(cloudControlPlaneTick({ store, evaluateDecisions: true }), /configured policy/);
});

test("headless cloud command invocation is batch bounded and never dispatches or ships", async () => {
  const { store } = fixture();
  const queue = {
    claims: 0,
    async claimRemoteCommand() {
      this.claims++;
      return { id: "cmd-" + this.claims, kind: "intake", payload: { content: "fixture" } };
    },
    async finishRemoteCommand() {},
  };
  const service = {
    addToDepot: async () => ({ id: "durable" }),
    engine: {
      async runTriage() { return { triaged: 1 }; },
      async runDispatch() { throw new Error("Cloud must not dispatch execution"); },
      async runUnblocker() { throw new Error("Cloud must not auto-cleanup"); },
    },
  };
  const result = await cloudControlPlaneTick({
    store, service, commandQueue: queue, handleCommands: true,
    evaluateDecisions: true, maxCommands: 3,
  });
  assert.equal(result.remote_commands, 3);
  assert.equal(result.triaged, 1);
  assert.equal(queue.claims, 3);
});
