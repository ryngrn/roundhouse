#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureCommand } from "./intake.js";
import { depotCommand } from "./workflow/cli.js";
import { loadWorkflowConfig } from "./workflow/config.js";
import { exportFileDigest, importNotionDepot } from "./workflow/notion-depot-migration.js";
import { Store } from "./workflow/store.js";

function usage() {
  return `Usage:
  roundhouse capture --input <idea.json> --manifest <manifest.yaml> --state-dir <directory>
  roundhouse depot <submit|run|status|outbox|approve|clarify|reevaluate-import|stop|resume|recover> [...]
  roundhouse migrate notion-depot <export.json> [--state-dir <directory>] [--config <projects.yaml>]`;
}

function migrateCommand(argv) {
  const [kind, input, ...rest] = argv;
  if (kind !== "notion-depot" || !input || input.startsWith("--")) throw new Error(usage());
  const support = path.join(os.homedir(), "Library", "Application Support", "Roundhouse");
  const options = {
    stateDirectory: process.env.ROUNDHOUSE_STATE_DIR ?? path.join(support, "state"),
    configFile: process.env.ROUNDHOUSE_CONFIG ?? path.join(support, "projects.yaml"),
  };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Invalid option ${flag}\n\n${usage()}`);
    if (flag === "--state-dir") options.stateDirectory = value;
    else if (flag === "--config") options.configFile = value;
    else throw new Error(`Unknown option ${flag}\n\n${usage()}`);
  }
  const filename = path.resolve(input);
  const bytes = fs.readFileSync(filename);
  let exportData;
  try { exportData = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Notion Depot export must be valid JSON."); }
  const configuredProjects = fs.existsSync(path.resolve(options.configFile))
    ? loadWorkflowConfig(path.resolve(options.configFile)).projects
    : [];
  return importNotionDepot({
    store: new Store(path.resolve(options.stateDirectory)),
    exportData,
    exportDigest: exportFileDigest(bytes),
    configuredProjects,
  });
}

try {
  if (process.argv[2] === "depot") {
    process.stdout.write(`${JSON.stringify(await depotCommand(process.argv.slice(3)), null, 2)}\n`);
  } else if (process.argv[2] === "migrate") {
    process.stdout.write(`${JSON.stringify(migrateCommand(process.argv.slice(3)), null, 2)}\n`);
  } else if (process.argv[2] === "capture") {
    process.stdout.write(`${JSON.stringify(captureCommand(process.argv.slice(3)))}\n`);
  } else {
    throw new Error(usage());
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 64;
}
