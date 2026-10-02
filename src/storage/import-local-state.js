import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadNodeIdentity } from "./node-identity.js";
import { PostgresStorageRepository } from "./postgres.js";
import { acquireLock } from "./file-lock.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

function backupName(stateDirectory, now) {
  const stamp = now.replaceAll(":", "-").replaceAll(".", "-");
  return path.join(path.dirname(stateDirectory), "migrations", `state.before-postgres.${stamp}.json`);
}

export async function importLocalStateToPostgres({ stateDirectory, connectionString = process.env.DATABASE_URL,
  env = process.env, allowInsecure = false, now = () => new Date().toISOString() } = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is required; no PostgreSQL cutover was performed.");
  const directory = path.resolve(stateDirectory);
  const filename = path.join(directory, "state.json");
  if (!fs.existsSync(filename)) throw new Error(`Local state does not exist: ${filename}`);
  const releaseWorker = acquireLock(path.join(directory, "worker.lock"));
  let releaseState;
  try {
    releaseState = acquireLock(path.join(directory, "state.lock"));
    const bytes = fs.readFileSync(filename);
    const snapshot = JSON.parse(bytes.toString("utf8"));
    if (snapshot.schema_version !== 1 || !snapshot.items || !snapshot.jobs) throw new Error("Unsupported or invalid local state snapshot.");
    const digest = sha256(bytes);
    const completedAt = now();
    const backup = backupName(directory, completedAt);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
    const backupFd = fs.openSync(backup, "r");
    try { fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
    const backupDirectoryFd = fs.openSync(path.dirname(backup), "r");
    try { fs.fsyncSync(backupDirectoryFd); } finally { fs.closeSync(backupDirectoryFd); }

    const node = loadNodeIdentity(directory, env);
    const store = await PostgresStorageRepository.open({ connectionString, directory, node, allowInsecure });
    try {
      const existing = await store.read();
      const prior = existing.system_metadata?.postgres_import;
      if (prior?.source_digest === digest) {
        return { imported: false, already_imported: true, source_digest: digest, backup, ...prior };
      }
      if (Object.keys(existing.items).length || Object.keys(existing.jobs).length) {
        throw new Error("PostgreSQL already contains Roundhouse work; refusing to replace authoritative state.");
      }
      snapshot.project_candidates ??= {};
      snapshot.system_metadata ??= {};
      snapshot.outbox ??= [];
      snapshot.system_metadata.postgres_import = {
        source_digest: digest,
        source_file: filename,
        backup_file: backup,
        completed_at: completedAt,
        item_count: Object.keys(snapshot.items).length,
        job_count: Object.keys(snapshot.jobs).length,
        imported_pending_count: Object.values(snapshot.items).filter((item) => item.state === "Imported Pending").length,
        shipped_job_count: Object.values(snapshot.jobs).filter((job) => job.state === "Shipped").length,
        shipped_job_ids: Object.values(snapshot.jobs).filter((job) => job.state === "Shipped").map((job) => job.id),
        notion_record_count: Object.values(snapshot.items).filter((item) =>
          item.provenance?.source_system === "notion" || (item.legacy_sources ?? []).some((source) => source.source_system === "notion")).length,
        execution_started: false,
      };
      await store.change((data) => {
        for (const key of Object.keys(data)) delete data[key];
        Object.assign(data, structuredClone(snapshot));
      });
      const verified = await store.read();
      if (Object.keys(verified.items).length !== Object.keys(snapshot.items).length
        || Object.keys(verified.jobs).length !== Object.keys(snapshot.jobs).length) {
        throw new Error("PostgreSQL import verification failed.");
      }
      for (const [id, item] of Object.entries(snapshot.items)) {
        if (!verified.items[id] || !same(verified.items[id], item)) {
          throw new Error(`PostgreSQL import verification failed for item ${id}.`);
        }
      }
      for (const [id, job] of Object.entries(snapshot.jobs)) {
        if (!verified.jobs[id] || !same(verified.jobs[id].history, job.history)) {
          throw new Error(`PostgreSQL import verification failed for job ${id}.`);
        }
      }
      return { imported: true, already_imported: false, source_digest: digest, backup,
        ...snapshot.system_metadata.postgres_import };
    } finally {
      await store.close();
    }
  } finally {
    try { if (releaseState) releaseState(); } finally { releaseWorker(); }
  }
}
