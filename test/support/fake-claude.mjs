#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const packet = input.slice(input.lastIndexOf("\n") + 1);
const decide = process.argv.includes("--json-schema");
const provider = fileURLToPath(new URL("./providers.mjs", import.meta.url));
const run = spawnSync(process.execPath, [provider, decide ? "decide" : "execute"], { input: packet, encoding: "utf8" });
const failed = run.status !== 0;
const envelope = { type: "result", is_error: failed, result: run.stdout };
if (decide && !failed) envelope.structured_output = JSON.parse(run.stdout);
process.stdout.write(JSON.stringify(envelope));
