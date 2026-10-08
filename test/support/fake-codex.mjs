#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const packet = input.slice(input.lastIndexOf("\n") + 1);
const args = process.argv.slice(2);
const responseFlag = args.indexOf("--output-last-message");
const deciding = args.includes("--output-schema") && responseFlag >= 0;
const provider = fileURLToPath(new URL("./providers.mjs", import.meta.url));
const run = spawnSync(process.execPath, [provider, deciding ? "decide" : "execute"], {
  input: packet,
  encoding: "utf8",
});

if (run.status !== 0) {
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 1);
}
if (deciding) fs.writeFileSync(args[responseFlag + 1], run.stdout);
else process.stdout.write(run.stdout);
