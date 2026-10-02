import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/workflow/store.js";

test("Depot rejects blank submissions without storing items", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-blank-depot-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const store = new Store(directory);

  assert.throws(() => store.submit({ text: "" }, "empty"), /nonempty text/);
  assert.equal(Object.keys(store.read().items).length, 0);

  assert.throws(() => store.submit({ text: " \t\n" }, "whitespace"), /nonempty text/);
  assert.equal(Object.keys(store.read().items).length, 0);
});
