import test from "node:test";
import assert from "node:assert/strict";
import { parseCloudFlags, runCloudControlPlane } from "../src/server/cloud-control-plane-cli.js";

const env = {
  DATABASE_URL: "postgresql://cloud.example/db",
  ROUNDHOUSE_STATE_DIR: "/tmp/roundhouse-cloud-tests",
  ROUNDHOUSE_CONFIG: "/tmp/projects.yaml",
};

test("headless invocation is inert by default and denies unapproved capabilities", () => {
  assert.deepEqual(parseCloudFlags([], env), {
    recordSchedules: false, recover: false, handleCommands: false,
    evaluateDecisions: false, maxDue: 10, maxCommands: 5,
  });
  assert.throws(() => parseCloudFlags(["--commands"], env), /disabled/);
  assert.throws(() => parseCloudFlags(["--triage"], env), /durable attempts/);
  assert.throws(() => parseCloudFlags(["--due", "--due"], env), /Usage/);
  assert.throws(() => parseCloudFlags(["--publish"], env), /Usage/);
});

test("runner refuses absent PostgreSQL authority and unstable cloud identity before opening", async () => {
  let opened = false;
  const openAuthority = async () => { opened = true; };
  await assert.rejects(runCloudControlPlane(["--due"], {}, { openAuthority }), /requires PostgreSQL/);
  await assert.rejects(runCloudControlPlane([], { DATABASE_URL: env.DATABASE_URL }, { openAuthority }), /persistent/);
  assert.equal(opened, false);
});

test("headless runner opens PostgreSQL with no execution or shipping capabilities, then closes it", async () => {
  const calls = [];
  const store = { close: async () => { calls.push("close"); } };
  const output = await runCloudControlPlane(["--due", "--recover"], env, {
    openAuthority: async (args) => {
      assert.equal(args.env.ROUNDHOUSE_STORAGE_MODE, "postgresql");
      assert.equal(args.env.ROUNDHOUSE_NODE_CAPABILITIES, "decision");
      assert.equal(args.connectionString, env.DATABASE_URL);
      calls.push("open");
      return store;
    },
    tick: async (input) => {
      assert.equal(input.store, store);
      assert.equal(input.recordSchedules, true);
      assert.equal(input.recover, true);
      assert.equal(input.handleCommands, false);
      assert.equal(input.evaluateDecisions, false);
      calls.push("tick");
      return { ok: true };
    },
  });
  assert.deepEqual(output, { ok: true });
  assert.deepEqual(calls, ["open", "tick", "close"]);
});

test("runner releases PostgreSQL connection after failed tick", async () => {
  let closed = false;
  await assert.rejects(runCloudControlPlane([], env, {
    openAuthority: async () => ({ close: async () => { closed = true; } }),
    tick: async () => { throw new Error("database unavailable"); },
  }), /database unavailable/);
  assert.equal(closed, true);
});
