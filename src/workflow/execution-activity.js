import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const resolved = (value) => {
  if (!value) return null;
  const absolute = path.resolve(value);
  try { return fs.realpathSync.native(absolute); } catch { return absolute; }
};
const commandText = (command) => Array.isArray(command) ? command.map(String).join(" ") : String(command ?? "");

function executorSignatures(projects, providers = []) {
  const signatures = [];
  for (const project of projects ?? []) {
    if (project.executor?.kind === "codex") signatures.push(commandText([project.executor.bin ?? "codex", "exec"]));
    if (project.executor?.kind === "command" && project.executor.command?.length) signatures.push(commandText(project.executor.command));
    if (project.runtime === "herdr") signatures.push("herdr --machine");
  }
  for (const provider of providers) if (provider.kind === "command" && provider.command?.length) signatures.push(commandText(provider.command));
  return [...new Set(signatures.filter(Boolean))];
}

function systemProcesses() {
  if (process.platform === "win32") throw new Error("Process inspection is not supported on Windows.");
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5_000 });
  return output.split("\n").map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), parent_pid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

function repositoryWorktrees(repository) {
  const output = execFileSync("git", ["-C", repository, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 5_000 });
  const entries = [];
  let current = null;
  for (const line of `${output}\n`.split("\n")) {
    if (line.startsWith("worktree ")) current = { path: line.slice(9), repository };
    else if (current && line.startsWith("HEAD ")) current.commit = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line === "detached") current.detached = true;
    else if (current && line === "") { entries.push(current); current = null; }
  }
  return entries;
}

export function correlateExecutionActivity({ data, projects = [], providers = [], observedProcesses = [], observedWorktrees = [] }) {
  const recordedProcesses = new Map(Object.values(data.jobs ?? {}).flatMap((job) => (job.processes ?? []).map((entry) => [Number(entry.pid), entry])));
  const preparedWorkspaces = new Set(Object.values(data.jobs ?? {}).map((job) => resolved(job.prepared?.workspace)).filter(Boolean));
  const signatures = executorSignatures(projects, providers);
  const processes = observedProcesses
    .map((entry) => ({ entry, signature: signatures.find((signature) => commandText(entry.command).includes(signature)) }))
    .filter(({ signature }) => signature)
    .filter(({ entry }) => {
      const launch = recordedProcesses.get(Number(entry.pid));
      return !launch || (launch.command && !commandText(entry.command).includes(commandText(launch.command)));
    })
    .map(({ entry, signature }) => ({ kind: "process", status: "untracked", authoritative: false, pid: Number(entry.pid),
      parent_pid: entry.parent_pid === undefined ? null : Number(entry.parent_pid), executable: path.basename(signature.split(" ")[0]),
      observed_at: entry.observed_at ?? null }));
  const worktrees = observedWorktrees
    .filter((entry) => resolved(entry.path) !== resolved(entry.repository))
    .filter((entry) => !preparedWorkspaces.has(resolved(entry.path)))
    .map((entry) => ({ kind: "worktree", status: "untracked", authoritative: false, repository: resolved(entry.repository),
      path: resolved(entry.path), branch: entry.branch ?? null, commit: entry.commit ?? null, observed_at: entry.observed_at ?? null }));
  return [...processes, ...worktrees];
}

export function inspectExecutionActivity({ data, projects = [], providers = [], processLister = systemProcesses, worktreeLister = repositoryWorktrees } = {}) {
  const checked_at = new Date().toISOString();
  const warnings = [];
  let observedProcesses = [];
  let processInspection = "available";
  try { observedProcesses = processLister(); }
  catch (error) { processInspection = "unavailable"; warnings.push(`Process inspection unavailable: ${error.message}`); }

  const observedWorktrees = [];
  let worktreeInspection = "available";
  const repositories = [...new Set((projects ?? []).map((project) => project.repository).filter(Boolean).map(resolved))];
  for (const repository of repositories) {
    try { observedWorktrees.push(...worktreeLister(repository)); }
    catch (error) { worktreeInspection = "partial"; warnings.push(`Worktree inspection unavailable for ${repository}: ${error.message}`); }
  }
  if (!repositories.length) worktreeInspection = "not_configured";
  const activity = correlateExecutionActivity({ data, projects, providers, observedProcesses, observedWorktrees })
    .map((entry) => ({ ...entry, observed_at: entry.observed_at ?? checked_at }));
  return { checked_at, process_inspection: processInspection, worktree_inspection: worktreeInspection, warnings, activity };
}
