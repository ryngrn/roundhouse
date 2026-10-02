import { createHash } from "node:crypto";

/**
 * Storage contract used by workflow code.
 *
 * Repositories expose a compatibility snapshot for the domain while keeping the
 * authoritative representation private. LocalStorageRepository is intentionally
 * single-node. PostgreSQLStorageRepository persists normalized records and adds
 * distributed claims/leases. Methods may return a value or a Promise; callers at
 * network/worker boundaries await them so the local adapter stays convenient in
 * deterministic tests.
 */
export class StorageRepository {
  constructor({ kind, shared }) {
    if (new.target === StorageRepository) throw new TypeError("StorageRepository is abstract.");
    this.kind = kind;
    this.shared = shared;
  }

  read() { throw new Error("read() is not implemented."); }
  change() { throw new Error("change() is not implemented."); }
  submit() { throw new Error("submit() is not implemented."); }
  status() { return { kind: this.kind, shared: this.shared, connected: true, read_only: false }; }
  close() {}
}

export const isPromise = (value) => Boolean(value && typeof value.then === "function");
export const mapResult = (value, fn) => isPromise(value) ? value.then(fn) : fn(value);
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
