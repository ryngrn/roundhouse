import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";

export const shippingModes = ["commit_only", "push_branch", "create_pull_request", "merge_to_main", "deploy"];
const check = (value, message) => { if (!value) throw new Error(message); };
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
export const commandValid = (command) => Array.isArray(command) && command.length > 0 && command.every((value) => nonempty(value));

function normalizeProjects(raw, root) {
  check(Array.isArray(raw?.projects), "Manifest must contain a projects array.");
  const ids = new Set();
  return raw.projects.map((project) => {
    check(project && typeof project === "object" && !Array.isArray(project), "Invalid project.");
    for (const field of ["id", "name", "purpose", "success_state"]) check(nonempty(project[field]), `Project requires ${field}.`);
    check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.id), "Project id must be a stable lowercase slug.");
    check(!ids.has(project.id), `Duplicate project id: ${project.id}`);
    ids.add(project.id);
    check(["active", "paused", "archived"].includes(project.status), "Invalid project status.");
    const weight = project.weight ?? 1;
    const max_concurrent_runs = project.max_concurrent_runs ?? 1;
    check(Number.isFinite(weight) && weight > 0, "Project weight must be positive.");
    check(Number.isInteger(max_concurrent_runs) && max_concurrent_runs > 0, "Project concurrency must be a positive integer.");
    const metric_definitions = project.metric_definitions ?? [];
    check(Array.isArray(metric_definitions), "Metric definitions must be an array.");
    const metricKeys = new Set();
    for (const metric of metric_definitions) {
      check(metric && ["key", "name", "description"].every((key) => nonempty(metric[key])), "Invalid metric definition.");
      check(!metricKeys.has(metric.key), `Duplicate metric key: ${metric.key}`);
      metricKeys.add(metric.key);
      check(["percent", "count", "duration", "currency", "score"].includes(metric.unit), "Invalid metric unit.");
      check(["increase", "decrease", "maintain"].includes(metric.desired_direction), "Invalid metric direction.");
    }
    const policy = {
      allow_autonomous: false,
      approval_required: false,
      review_after_shipping: false,
      project_confidence: 0.85,
      execution_confidence: 0.85,
      shipping: "push_branch",
      continuation: "stop_after_job",
      max_rework_attempts: 1,
      ...(project.policy ?? {}),
    };
    for (const key of ["allow_autonomous", "approval_required", "review_after_shipping"]) check(typeof policy[key] === "boolean", `${key} must be boolean.`);
    for (const key of ["project_confidence", "execution_confidence"]) check(Number.isFinite(policy[key]) && policy[key] >= 0 && policy[key] <= 1, `Invalid ${key} threshold.`);
    check(shippingModes.includes(policy.shipping), "Unknown shipping policy.");
    check(["stop_after_job", "continue_project_queue"].includes(policy.continuation), "Unknown continuation policy.");
    check(Number.isInteger(policy.max_rework_attempts) && policy.max_rework_attempts >= 0 && policy.max_rework_attempts <= 10, "Rework limit must be 0–10.");
    check(nonempty(project.repository), `Project ${project.id} requires repository for this software runtime.`);
    const repository = fs.realpathSync(path.resolve(root, project.repository));
    check(Array.isArray(project.verification) && project.verification.length > 0, "At least one verification command is required.");
    const verificationKeys = new Set();
    for (const rule of project.verification) {
      check(nonempty(rule.id) && !verificationKeys.has(rule.id), "Verification IDs must be nonempty and unique.");
      verificationKeys.add(rule.id);
      check(commandValid(rule.command), "Verification command must be an argv array.");
    }
    const executor = project.executor ?? { kind: "codex", bin: "codex" };
    check(["codex", "command"].includes(executor.kind), "Unknown executor.");
    if (executor.kind === "command") check(commandValid(executor.command), "Executor requires an argv array.");
    check((project.runtime ?? "local") === "local", "Only the local runtime is installed.");
    const timeout_ms = project.timeout_ms ?? 120 * 60_000;
    check(Number.isInteger(timeout_ms) && timeout_ms > 0, "timeout_ms must be positive.");
    check(project.context_sources === undefined || (Array.isArray(project.context_sources) && project.context_sources.every((source) => typeof source === "string")), "context_sources must be file paths.");
    let deployment = project.deployment;
    if (policy.shipping === "deploy") {
      check(deployment && typeof deployment === "object" && !Array.isArray(deployment), `Project ${project.id} requires deployment configuration.`);
      check(["fixture", "command"].includes(deployment.kind), "Deployment provider must be fixture or command.");
      if (deployment.kind === "command") check(commandValid(deployment.command), "Command deployment provider requires an argv array.");
      check(deployment.environment === undefined || nonempty(deployment.environment), "Deployment environment must be nonempty.");
      check(deployment.push_branch === undefined || typeof deployment.push_branch === "boolean", "deployment.push_branch must be boolean.");
      deployment = { environment: "production", push_branch: false, ...deployment };
    } else if (deployment !== undefined) {
      check(deployment && typeof deployment === "object" && !Array.isArray(deployment), "Invalid deployment configuration.");
    }
    return {
      ...project, repository, weight, max_concurrent_runs, metric_definitions, policy, executor,
      runtime: "local", timeout_ms, remote: project.remote ?? "origin", base_ref: project.base_ref ?? "HEAD",
      ...(deployment ? { deployment } : {}),
    };
  });
}

export function validateWorkflowConfig(raw, filename) {
  check(raw && typeof raw === "object" && !Array.isArray(raw), "Configuration must be an object.");
  const absolute = path.resolve(filename);
  const projects = normalizeProjects(raw, path.dirname(absolute));
  const decision = raw.decision ?? { kind: "codex", bin: "codex" };
  check(["codex", "command"].includes(decision.kind), "Unknown decision provider.");
  if (decision.kind === "command") check(commandValid(decision.command), "Decision provider requires an argv array.");
  const max_jobs_per_run = raw.max_jobs_per_run ?? 20;
  check(Number.isInteger(max_jobs_per_run) && max_jobs_per_run > 0 && max_jobs_per_run <= 1000, "max_jobs_per_run must be 1–1000.");
  return { projects, decision, max_jobs_per_run, filename: absolute };
}

export function loadWorkflowConfig(filename) {
  const absolute = path.resolve(filename);
  return validateWorkflowConfig(YAML.parse(fs.readFileSync(absolute, "utf8")), absolute);
}

export function readWorkflowConfig(filename) {
  return YAML.parse(fs.readFileSync(path.resolve(filename), "utf8"));
}

export function saveWorkflowConfig(filename, raw) {
  const absolute = path.resolve(filename);
  validateWorkflowConfig(raw, absolute);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, YAML.stringify(raw)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, absolute);
  const directory = fs.openSync(path.dirname(absolute), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return loadWorkflowConfig(absolute);
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
