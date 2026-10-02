import { Store } from "../workflow/store.js";
import { loadNodeIdentity } from "./node-identity.js";
import { PostgresStorageRepository } from "./postgres.js";

export async function openStorage({ directory, env = process.env, connectionString, allowInsecure = false, leaseMs } = {}) {
  const databaseUrl = connectionString ?? env.DATABASE_URL;
  if (!databaseUrl) return new Store(directory, { env });
  const node = loadNodeIdentity(directory, env);
  return PostgresStorageRepository.open({ connectionString: databaseUrl, directory, node, allowInsecure, leaseMs });
}
