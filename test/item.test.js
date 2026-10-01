import assert from "node:assert/strict";
import test from "node:test";
import { assertReady, normalizeItem } from "../src/item.js";

test("normalizes flat Notion MCP properties", () => {
  const item = normalizeItem({
    url: "https://app.notion.com/p/abc",
    properties: { Item: "Ship feature", Project: "Inclusion", Status: "Ready" },
  });
  assert.equal(item.title, "Ship feature");
  assert.equal(item.project, "Inclusion");
  assert.doesNotThrow(() => assertReady(item));
});

test("does not execute non-Ready work", () => {
  const item = normalizeItem({ Item: "Shape feature", Project: "Inclusion", Status: "Ready to Slice" });
  assert.throws(() => assertReady(item), (error) => error.code === "ITEM_NOT_READY");
});
