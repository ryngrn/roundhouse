import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
