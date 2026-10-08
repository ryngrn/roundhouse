import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("only the canonical Depot, combined MCP, and hosted browser entry points remain", () => {
  const cli = fs.readFileSync("src/cli.js", "utf8");
  const server = fs.readFileSync("src/server/app-server.js", "utf8");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

  assert.doesNotMatch(cli, /captureCommand|roundhouse capture/);
  assert.equal(pkg.scripts.mcp, undefined);
  assert.equal(pkg.scripts.visual, undefined);
  assert.equal(fs.existsSync("src/intake.js"), false);
  assert.equal(fs.existsSync("src/server/front-door.js"), false);
  assert.equal(fs.existsSync("src/mcp/http-server.js"), false);
  assert.equal(fs.existsSync("src/web/index.html"), false);

  assert.match(server, /handleMcpRequest/);
  assert.match(server, /https:\/\/roundhouse\.ryan\.green/);
  assert.doesNotMatch(server, /webRoot|assets\.has|\[host, "roundhouse"/);
});
