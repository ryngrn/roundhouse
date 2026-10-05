import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { harness } from "../test/support/harness.js";
import { Engine } from "../src/workflow/engine.js";
import { loadWorkflowConfig } from "../src/workflow/config.js";
import { git } from "../src/workflow/delivery.js";
import { statusView } from "../src/workflow/cli.js";

const live = process.argv.includes("--live");
const agent = process.argv.includes("--claude") ? "claude" : "codex";
const bin = agent === "claude" ? process.env.ROUNDHOUSE_CLAUDE_BIN ?? "claude" : process.env.ROUNDHOUSE_CODEX_BIN ?? "codex";
const h = harness();
if (live) {
  const config = JSON.parse(fs.readFileSync(h.configFile, "utf8"));
  config.decision = { kind: agent, bin };
  config.projects[0].executor = { kind: agent, bin };
  config.projects[0].verification = [{ id: "feature", command: [process.execPath, "-e", "const fs=require('fs'),cp=require('child_process'); if(fs.readFileSync('feature.txt','utf8')!=='implemented: first useful change\\n') process.exit(1); if(cp.execFileSync('git',['diff','--name-only','main','HEAD'],{encoding:'utf8'}).trim()!=='feature.txt') process.exit(2);"] }];
  fs.writeFileSync(h.configFile, JSON.stringify(config));
  h.config = loadWorkflowConfig(h.configFile);
  h.engine = new Engine({ store: h.store, config: h.config });
}
h.submit("Please add feature.txt at the repository root containing exactly 'implemented: first useful change' followed by a newline. This is the complete scope. The configured feature check verifies the entry. No other files need to change.", "demo-first");
if (!live) h.submit("second useful change", "demo-second");
process.stdout.write(`Running ${live ? `live ${agent === "claude" ? "Claude Code" : "Codex"}` : "deterministic local-process"} demo in ${h.root}\n`);
const result = await h.engine.run();
const view = statusView(result);
const jobs = Object.values(result.jobs);
assert.equal(jobs.length, live ? 1 : 2, JSON.stringify(view));
assert.ok(jobs.every((job) => job.state === "Shipped"), JSON.stringify(view));
for (const job of jobs) assert.equal(git(h.remote, ["rev-parse", job.shipping.branch]), job.shipping.commit);
const report = { mode: live ? `live-${agent}` : "deterministic-local-process", passed: true, directory: h.root,
  executed: result.executed, human_reviews: result.outbox.filter((e) => e.state === "Review").length,
  shipped: jobs.map((job) => ({ branch: job.shipping.branch, commit: job.shipping.commit, verified: job.shipping.verification.passed, pushed: job.shipping.pushed })) };
fs.writeFileSync(path.join(h.root, "demo-result.json"), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
