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

function validateSite() {
  const root = "site";
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const workflow = fs.readFileSync(".github/workflows/pages.yml", "utf8");
  for (const required of ["<main id=\"main\">", "id=\"workflow\"", "id=\"architecture\"", "id=\"quick-start\"", "id=\"status\"", "<svg", "https://roundhouse.ryan.green", "MCP Events"]) {
    if (!html.includes(required)) throw new Error(`Public site is missing required content: ${required}`);
  }
  if (/<script\b/i.test(html) || /analytics|segment\.com|googletagmanager|fonts\.googleapis/i.test(html)) throw new Error("Public site must remain tracker-free and dependency-light.");
  if (/\b(?:href|src)=["']\/(?!\/)/i.test(html)) throw new Error("Public site assets must be relative so GitHub Pages works under /roundhouse/.");
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  for (const [, href] of html.matchAll(/\bhref=["']([^"']+)["']/g)) {
    if (href.startsWith("#") && !ids.has(href.slice(1))) throw new Error(`Broken site anchor: ${href}`);
    if (/^(?:https?:|mailto:|#)/.test(href) || href === "./") continue;
    const local = href.split("#", 1)[0].split("?", 1)[0];
    if (!fs.existsSync(path.join(root, local))) throw new Error(`Broken local site link: ${href}`);
  }
  const opens = (css.match(/{/g) ?? []).length;
  const closes = (css.match(/}/g) ?? []).length;
  if (opens !== closes) throw new Error("Public site CSS has unbalanced blocks.");
  for (const action of ["actions/checkout@v6", "actions/configure-pages@v5", "actions/upload-pages-artifact@v4", "actions/deploy-pages@v4"]) {
    if (!workflow.includes(action)) throw new Error(`Pages workflow is missing ${action}.`);
  }
  if (!/branches:\s*\[main\]/.test(workflow) || !/workflow_dispatch:/.test(workflow) || !/path:\s*site/.test(workflow)) {
    throw new Error("Pages workflow must deploy site/ only from main or workflow_dispatch.");
  }
  if (fs.existsSync(path.join(root, "CNAME"))) throw new Error("A custom Pages domain is not configured for this site.");
}
validateSite();

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
