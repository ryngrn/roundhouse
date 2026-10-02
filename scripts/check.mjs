import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) check(filename);
    else if (/\.[cm]?js$/.test(filename)) {
      const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
      if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
    }
  }
}
for (const directory of ["src", "test", "scripts"]) check(directory);

const plugin = JSON.parse(fs.readFileSync("plugin/roundhouse/plugin.json", "utf8"));
const mcp = JSON.parse(fs.readFileSync("plugin/roundhouse/mcp.json", "utf8"));
if (plugin.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" ||
    plugin.name !== "roundhouse" || !plugin.extensions?.["com.openai"]?.interface) {
  throw new Error("Invalid Roundhouse plugin manifest.");
}
const endpoint = mcp.mcpServers?.roundhouse;
if (mcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" ||
    endpoint?.type !== "streamable-http" || !/^https:\/\/.+\/mcp$/.test(endpoint.url)) {
  throw new Error("Invalid Roundhouse MCP manifest.");
}
