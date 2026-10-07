import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { record, transition } from "./state.js";

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
};

export function acquireLock(directory) {
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Locked: ${directory}. Another worker may be active; inspect before recovery.`);
    throw error;
  }
  const owner = { pid: process.pid, hostname: os.hostname(), token: randomUUID(), at: new Date().toISOString() };
  fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
  const release = () => {
    const current = JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8"));
    if (current.token !== owner.token) throw new Error("Lock ownership changed.");
    fs.unlinkSync(path.join(directory, "owner.json"));
    fs.rmdirSync(directory);
  };
  release.directory = directory;
  return release;
}

function atomicWrite(filename, data) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  const dir = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export class Store {
  constructor(directory) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.file = path.join(this.directory, "state.json");
    this.workerLock = path.join(this.directory, "worker.lock");
  }
  read() {
    if (!fs.existsSync(this.file)) return { schema_version: 1, items: {}, jobs: {}, projects: {}, outbox: [] };
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
    for (const field of ["project_id", "goal_id"]) {
      if (input[field] !== undefined && (typeof input[field] !== "string" || !input[field].trim())) throw new Error(`${field} must be a nonempty string when provided.`);
    }
    if (typeof key !== "string" || !key.trim()) throw new Error("A stable submission key is required.");
    const id = digest(key).slice(0, 24);
    return this.change((data) => {
      if (data.items[id]) {
        if (digest(data.items[id].input) !== digest(input)) throw new Error("Submission key already exists with different content. Use clarify or a new key.");
        return data.items[id];
      }
      data.items[id] = record(id, {
        input, project_id: input.project_id ?? null, goal_id: input.goal_id ?? null,
        clarifications: [], decision: null, decision_history: [], job_ids: [],
        refinement: { active_question: null, answers: [] },
      });
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
        for (const entity of [...Object.values(state.items), ...Object.values(state.jobs)]) {
          if (["Decision", "Executing", "Verification", "Rework"].includes(entity.state)) {
            this.move(state, entity, "Blocked", "Interrupted attempt: inspect workspace and remote delivery before submitting replacement work.");
          }
        }
        for (const project of Object.values(state.projects)) if (project.active) { project.blocked = true; project.active = false; }
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
    return this.read();
  }
}
