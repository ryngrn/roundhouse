#!/usr/bin/env node
import path from "node:path";
import { DEFAULT_CONFIG_PATH } from "./config.js";
import { dispatch } from "./dispatch.js";

function usage() {
  return `Usage:
  roundhouse dispatch --item <notion-item.json> [--config <projects.yaml>] [--dry-run]

The command writes JSONL lifecycle events to stdout. A bridge such as ChatGPT +
Remote Desktop Commander applies notion.status_requested events to Notion.`;
}

function parseArgs(argv) {
  const args = { configPath: process.env.ROUNDHOUSE_CONFIG ?? DEFAULT_CONFIG_PATH };
  const [command, ...rest] = argv;
  if (command !== "dispatch") throw new Error(usage());
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--item") args.itemPath = rest[++index];
    else if (value === "--config") args.configPath = rest[++index];
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--help" || value === "-h") throw new Error(usage());
    else throw new Error(`Unknown argument: ${value}\n\n${usage()}`);
  }
  if (!args.itemPath) throw new Error(`--item is required.\n\n${usage()}`);
  args.itemPath = path.resolve(args.itemPath);
  args.configPath = path.resolve(args.configPath);
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  process.exitCode = await dispatch(args);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 64;
}
