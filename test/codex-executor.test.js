import assert from "node:assert/strict";
import test from "node:test";
import { codexArgs } from "../src/codex-executor.js";

test("uses the supported non-interactive approval mode", () => {
  const args = codexArgs("/tmp/repo");
  assert.deepEqual(args, ["exec", "--json", "--approve-for-me", "-C", "/tmp/repo", "-"]);
  assert.equal(args.includes("--full-auto"), false);
  assert.equal(args.includes("--sandbox"), false);
});
