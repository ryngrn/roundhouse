import test from "node:test";
import assert from "node:assert/strict";
import { processIsAlive } from "../src/workflow/engine.js";

test("reused PID is not treated as the original child process", () => {
  assert.equal(processIsAlive(process.pid, "2020-01-01T00:00:00.000Z"), false);
});
test("current child process is still considered active", () => {
  assert.equal(processIsAlive(process.pid, new Date().toISOString()), true);
});
test("unverifiable original process identity fails closed", () => {
  assert.equal(processIsAlive(process.pid, null), true);
});
