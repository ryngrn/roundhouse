import { Store } from "../workflow/store.js";
import { loadNodeIdentity } from "./node-identity.js";
import { PostgresStorageRepository } from "./postgres.js";

export async function openStorage({ directory, env = process.env, connectionString, allowInsecure = false, leaseMs } = {}) {
  const mode = env.ROUNDHOUSE_STORAGE_MODE ?? (connectionString ? "postgresql" : "local");
  if (mode === "local") return new Store(directory, { env });
  if (mode !== "postgresql") throw new Error(`Unsupported ROUNDHOUSE_STORAGE_MODE: ${mode}`);
  const databaseUrl = connectionString ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("ROUNDHOUSE_STORAGE_MODE=postgresql requires DATABASE_URL.");
  const node = loadNodeIdentity(directory, env);
  return PostgresStorageRepository.open({ connectionString: databaseUrl, directory, node, allowInsecure, leaseMs });
}
