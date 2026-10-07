import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadProjects } from "../intake.js";

export const shippingModes = ["commit_only", "push_branch", "create_pull_request", "merge_to_main", "deploy"];
const check = (value, message) => { if (!value) throw new Error(message); };
export const commandValid = (command) => Array.isArray(command) && command.length > 0 && command.every((v) => typeof v === "string" && v.length > 0);

export function loadWorkflowConfig(filename) {
  const absolute = path.resolve(filename);
  const root = path.dirname(absolute);
  const raw = YAML.parse(fs.readFileSync(absolute, "utf8"));
  const projects = loadProjects(absolute).map((p) => {
    const policy = {
      allow_autonomous: false, approval_required: false, review_after_shipping: false,
      project_confidence: 0.85, execution_confidence: 0.85,
      shipping: "push_branch", continuation: "stop_after_job", max_rework_attempts: 1,
      ...p.policy,
    };
    for (const key of ["allow_autonomous", "approval_required", "review_after_shipping"]) check(typeof policy[key] === "boolean", `${key} must be boolean.`);
    for (const key of ["project_confidence", "execution_confidence"]) check(Number.isFinite(policy[key]) && policy[key] >= 0 && policy[key] <= 1, `Invalid ${key} threshold.`);
    check(shippingModes.includes(policy.shipping), "Unknown shipping policy.");
    check(["stop_after_job", "continue_project_queue"].includes(policy.continuation), "Unknown continuation policy.");
    check(Number.isInteger(policy.max_rework_attempts) && policy.max_rework_attempts >= 0 && policy.max_rework_attempts <= 10, "Rework limit must be 0–10.");
    check(typeof p.repository === "string" && p.repository.length > 0, `Project ${p.id} requires repository for this software runtime.`);
    const repository = fs.realpathSync(path.resolve(root, p.repository));
    check(Array.isArray(p.verification) && p.verification.length > 0, "At least one verification command is required.");
    const keys = new Set();
    for (const rule of p.verification) {
      check(typeof rule.id === "string" && rule.id.trim() && !keys.has(rule.id), "Verification IDs must be nonempty and unique.");
      keys.add(rule.id);
      check(commandValid(rule.command), "Verification command must be an argv array.");
    }
    const executor = p.executor ?? { kind: "codex", bin: "codex" };
    check(["codex", "claude", "command"].includes(executor.kind), "Unknown executor.");
    if (executor.kind === "command") check(commandValid(executor.command), "Executor requires an argv array.");
    if (executor.kind === "claude" && executor.allowed_tools !== undefined) check(commandValid(executor.allowed_tools), "allowed_tools must be a nonempty list of tool rules.");
    check(["local", "herdr"].includes(p.runtime ?? "local"), "Unsupported runtime.");
    const timeout_ms = p.timeout_ms ?? 120 * 60_000;
    check(Number.isInteger(timeout_ms) && timeout_ms > 0, "timeout_ms must be positive.");
    check(p.context_sources === undefined || (Array.isArray(p.context_sources) && p.context_sources.every((s) => typeof s === "string")), "context_sources must be file paths.");
    return { ...p, repository, policy, executor, runtime: p.runtime ?? "local", timeout_ms, remote: p.remote ?? "origin", base_ref: p.base_ref ?? "HEAD" };
  });
  const decision = raw.decision ?? { kind: "codex", bin: "codex" };
  check(["codex", "claude", "command"].includes(decision.kind), "Unknown decision provider.");
  if (decision.kind === "command") check(commandValid(decision.command), "Decision provider requires an argv array.");
  const max_jobs_per_run = raw.max_jobs_per_run ?? 20;
  check(Number.isInteger(max_jobs_per_run) && max_jobs_per_run > 0 && max_jobs_per_run <= 1000, "max_jobs_per_run must be 1–1000.");
  return { projects, decision, max_jobs_per_run, filename: absolute };
}

export function projectContext(project) {
  return { ...project, context: (project.context_sources ?? []).map((relative) => {
    const filename = fs.realpathSync(path.resolve(project.repository, relative));
    const rel = path.relative(project.repository, filename);
    check(rel && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel), "Context source must remain inside repository.");
    check(fs.statSync(filename).size <= 65536, "Context file exceeds 64 KiB.");
    return { source: relative, text: fs.readFileSync(filename, "utf8") };
  }) };
}
