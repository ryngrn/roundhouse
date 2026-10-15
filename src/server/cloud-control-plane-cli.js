#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openStorage } from "../storage/open.js";
import { openPostgresRelay } from "../relay/postgres-relay.js";
import { RoundhouseService } from "../workflow/service.js";
import { cloudControlPlaneTick } from "./cloud-control-plane.js";

const usage = "Usage: node src/server/cloud-control-plane-cli.js [--health] [--due] [--recover] [--commands] [--triage]";

export function parseCloudFlags(args, env = process.env) {
  const known = new Set(["--health", "--due", "--recover", "--commands", "--triage"]);
  if (args.some((option) => !known.has(option)) || new Set(args).size !== args.length) throw new Error(usage);
  const flags = new Set(args);
  if (flags.has("--commands") && env.ROUNDHOUSE_CLOUD_COMMANDS !== "1")
    throw new Error("Cloud command processing is disabled; explicitly set ROUNDHOUSE_CLOUD_COMMANDS=1 on the hosted runner.");
  if (flags.has("--triage") && env.ROUNDHOUSE_DURABLE_DECISIONS !== "1")
    throw new Error("Cloud decisions require explicitly activated durable attempts.");
  if ((flags.has("--commands") || flags.has("--triage")) && !env.ROUNDHOUSE_CONFIG)
    throw new Error("Cloud commands and decisions require a shared approved ROUNDHOUSE_CONFIG.");
  return {
    recordSchedules: flags.has("--due"),
    recover: flags.has("--recover"),
    handleCommands: flags.has("--commands"),
    evaluateDecisions: flags.has("--triage"),
    maxDue: 10,
    maxCommands: 5,
  };
}

export async function runCloudControlPlane(args, env = process.env, {
  openAuthority = openStorage,
  openRelay = openPostgresRelay,
  serviceFactory = ({ store, configFile }) => new RoundhouseService({ store, configFile }),
  tick = cloudControlPlaneTick,
} = {}) {
  const options = parseCloudFlags(args, env);
  const connectionString = env.DATABASE_URL ?? env.ROUNDHOUSE_RELAY_DATABASE_URL;
  if (!connectionString || !env.ROUNDHOUSE_STATE_DIR) {
    throw new Error("Cloud control plane requires PostgreSQL credentials and persistent ROUNDHOUSE_STATE_DIR for stable node identity.");
  }
  const authorityEnv = { ...env, ROUNDHOUSE_STORAGE_MODE: "postgresql",
    ROUNDHOUSE_NODE_CAPABILITIES: "decision" };
  let store, relay;
  try {
    store = await openAuthority({ directory: path.resolve(env.ROUNDHOUSE_STATE_DIR),
      connectionString, env: authorityEnv });
    let service = null;
    if (options.handleCommands || options.evaluateDecisions) {
      service = serviceFactory({ store, configFile: path.resolve(env.ROUNDHOUSE_CONFIG) });
    }
    if (options.handleCommands) {
      relay = openRelay({ env, connectionString: env.ROUNDHOUSE_RELAY_DATABASE_URL ?? connectionString });
      if (!relay) throw new Error("Cloud commands require configured hosted relay.");
    }
    return await tick({ store, service, commandQueue: relay, ...options });
  } finally {
    if (relay) await relay.close().catch(() => {});
    if (store) await store.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runCloudControlPlane(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write("Cloud control plane: " + error.message + "\n");
    process.exitCode = 1;
  }
}
