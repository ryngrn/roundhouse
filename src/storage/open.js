import fs from "node:fs";
import path from "node:path";
import { Store } from "../workflow/store.js";
import { loadNodeIdentity } from "./node-identity.js";
import { PostgresStorageRepository } from "./postgres.js";

export async function openStorage({ directory, env = process.env, connectionString, allowInsecure = false, leaseMs } = {}) {
  const mode = env.ROUNDHOUSE_STORAGE_MODE ?? (connectionString ? "postgresql" : "local");
  if (mode === "local") {
    // A standalone CLI lacks the service wrapper's database environment.
    // Never allow it to mutate the obsolete local snapshot after cutover.
    const support = directory ? path.resolve(directory, "..") : "";
    if (directory && path.basename(path.resolve(directory)) === "state" &&
        path.basename(support) === "Roundhouse" &&
        fs.existsSync(path.join(support, "authority.enabled"))) {
      throw new Error("Cloud authority is enabled; refusing legacy local state. Use authenticated PostgreSQL credentials.");
    }
    return new Store(directory, { env });
  }
  if (mode !== "postgresql") throw new Error(`Unsupported ROUNDHOUSE_STORAGE_MODE: ${mode}`);
  const databaseUrl = connectionString ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("ROUNDHOUSE_STORAGE_MODE=postgresql requires DATABASE_URL.");
  const node = loadNodeIdentity(directory, env);
  return PostgresStorageRepository.open({ connectionString: databaseUrl, directory, node, allowInsecure, leaseMs });
}
