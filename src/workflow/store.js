import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { record, transition } from "./state.js";
import { StorageRepository, digest } from "../storage/repository.js";
import { acquireLock, alive } from "../storage/file-lock.js";
import { loadNodeIdentity } from "../storage/node-identity.js";

export { acquireLock, alive, digest };

function atomicWrite(filename, data) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  const dir = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export class Store extends StorageRepository {
  constructor(directory, { node, env = process.env } = {}) {
    super({ kind: "local", shared: false });
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.node = node ?? loadNodeIdentity(this.directory, env);
    this.file = path.join(this.directory, "state.json");
    this.workerLock = path.join(this.directory, "worker.lock");
    this.triageLock = path.join(this.directory, "triage.lock");
  }
  status() {
    return { kind: "local", shared: false, authoritative: true, connected: true, read_only: false,
      warning: "Local storage is single-node only.",
      node: { id: this.node.id, name: this.node.name, capabilities: this.node.capabilities } };
  }
  acquireWorkerLease() { return acquireLock(this.workerLock); }
  acquireTriageLease() { return acquireLock(this.triageLock); }
  read() {
    if (!fs.existsSync(this.file)) return { schema_version: 1, items: {}, jobs: {}, projects: {}, project_candidates: {}, system_metadata: {}, outbox: [] };
    const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (data.schema_version !== 1) throw new Error("Unsupported state version.");
    return data;
  }
  change(fn) {
    const release = acquireLock(path.join(this.directory, "state.lock"));
    try {
      const data = this.read();
      const result = fn(data);
      atomicWrite(this.file, data);
      return structuredClone(result ?? null);
    } finally { release(); }
  }
  submit(input, key) {
    if (!input || typeof input.text !== "string" || !input.text.trim()) throw new Error("Depot input requires nonempty text.");
    if (typeof key !== "string" || !key.trim()) throw new Error("A stable submission key is required.");
    const id = digest(key).slice(0, 24);
    return this.change((data) => {
      if (data.items[id]) {
        if (digest(data.items[id].input) !== digest(input)) throw new Error("Submission key already exists with different content. Use clarify or a new key.");
        return data.items[id];
      }
      data.items[id] = record(id, { input, clarifications: [], questions: [], decision: null, job_ids: [] });
      return data.items[id];
    });
  }
  move(data, entity, state, reason) {
    transition(entity, state, reason);
    const item = entity.parent_id ? data.items[entity.parent_id] : entity;
    data.outbox.push({ id: randomUUID(), entity_id: entity.id, item_id: item.id,
      source: item.input.source ?? null, state, reason, at: new Date().toISOString(), delivered: false });
  }
  recover() {
    const filename = path.join(this.workerLock, "owner.json");
    if (fs.existsSync(this.workerLock)) {
      if (!fs.existsSync(filename)) throw new Error("Incomplete lock owner metadata. Manual inspection required.");
      const owner = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (owner.hostname !== os.hostname() || alive(owner.pid)) throw new Error("Cannot recover a live or remote worker.");
      const data = this.read();
      const processes = [...Object.values(data.items), ...Object.values(data.jobs)].flatMap((job) => job.processes ?? []);
      if (processes.some((p) => alive(p.pid))) throw new Error("A recorded child process is still alive; recovery refused.");
      // A crash cannot prove an external action did not happen. Never replay it automatically.
      this.change((state) => {
        const interruptedProjects = new Set();
        for (const entity of [...Object.values(state.items), ...Object.values(state.jobs)]) {
          if (["Decision", "Executing", "Verification", "Rework"].includes(entity.state)) {
            const remote = entity.attempts?.at(-1)?.execution?.remote_execution;
            const reason = remote
              ? `Interrupted Herdr execution on ${remote.machine_selector}/${remote.agent_target}; explicit reconciliation is required and the prompt will not be replayed automatically.`
              : "Interrupted attempt: inspect workspace and remote delivery before submitting replacement work.";
            this.move(state, entity, "Blocked", reason);
            if (entity.parent_id && entity.project_id) interruptedProjects.add(entity.project_id);
          }
        }
        for (const [projectId, project] of Object.entries(state.projects)) {
          if (interruptedProjects.has(projectId)) project.blocked = true;
          if (project.active) project.active = false;
        }
      });
      for (const project of Object.values(this.read().projects)) {
        if (!project.repository_lock || !fs.existsSync(project.repository_lock)) continue;
        const repoOwnerFile = path.join(project.repository_lock, "owner.json");
        const repoOwner = JSON.parse(fs.readFileSync(repoOwnerFile, "utf8"));
        if (repoOwner.hostname !== os.hostname() || alive(repoOwner.pid)) throw new Error("Repository still has a live worker.");
        fs.unlinkSync(repoOwnerFile);
        fs.rmdirSync(project.repository_lock);
      }
      fs.unlinkSync(filename);
      fs.rmdirSync(this.workerLock);
    }
    const triageOwnerFile = path.join(this.triageLock, "owner.json");
    if (fs.existsSync(this.triageLock)) {
      if (!fs.existsSync(triageOwnerFile)) throw new Error("Incomplete triage lock owner metadata. Manual inspection required.");
      const owner = JSON.parse(fs.readFileSync(triageOwnerFile, "utf8"));
      if (owner.hostname !== os.hostname() || alive(owner.pid)) throw new Error("Cannot recover a live or remote triage worker.");
      this.change((state) => {
        for (const item of Object.values(state.items)) {
          if (item.state !== "Decision" || item.awaiting_decision) continue;
          this.move(state, item, "Blocked", "Interrupted triage attempt requires an explicit retry after inspection.");
          item.triage ??= { attempts: [], failure_count: 0 };
          item.triage.status = "interrupted";
          item.triage.interrupted = true;
          item.triage.blocked_fingerprint = "interrupted";
        }
      });
      fs.unlinkSync(triageOwnerFile);
      fs.rmdirSync(this.triageLock);
    }
    return this.read();
  }
}

export const LocalStorageRepository = Store;
