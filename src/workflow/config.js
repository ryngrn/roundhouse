import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { agentRoleIds } from "./roles.js";

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
    const runtime = project.runtime ?? "local";
    check(["local", "herdr"].includes(runtime), "Runtime must be local or herdr.");
    const herdr = runtime === "herdr" ? { workspace_mode: "shared_worktree", ...(project.herdr ?? {}) } : null;
    const machineLocal = herdr?.workspace_mode === "machine_local";
    if (!machineLocal) check(nonempty(project.repository), `Project ${project.id} requires repository for this software runtime.`);
    const repository = nonempty(project.repository) ? fs.realpathSync(path.resolve(root, project.repository)) : null;
    check(Array.isArray(project.verification) && project.verification.length > 0, "At least one verification command is required.");
    const verificationKeys = new Set();
    for (const rule of project.verification) {
      check(nonempty(rule.id) && !verificationKeys.has(rule.id), "Verification IDs must be nonempty and unique.");
      verificationKeys.add(rule.id);
      check(commandValid(rule.command), "Verification command must be an argv array.");
      check(rule.roles === undefined || (Array.isArray(rule.roles) && rule.roles.length > 0 && rule.roles.every((role) => agentRoleIds.includes(role))), "Verification roles must contain installed agent roles.");
      check(rule.evidence_ids === undefined || (Array.isArray(rule.evidence_ids) && rule.evidence_ids.every(nonempty)), "Verification evidence_ids must be strings.");
    }
    const executor = project.executor ?? { kind: "codex", bin: "codex" };
    check(["codex", "command"].includes(executor.kind), "Unknown executor.");
    if (executor.kind === "command") check(commandValid(executor.command), "Executor requires an argv array.");
    if (runtime === "herdr") {
      check(project.herdr && typeof project.herdr === "object" && !Array.isArray(project.herdr), `Project ${project.id} requires herdr configuration.`);
      check(nonempty(herdr.machine), `Project ${project.id} requires a nonempty herdr.machine selector.`);
      check(nonempty(herdr.agent), `Project ${project.id} requires a nonempty herdr.agent target.`);
      check(herdr.bin === undefined || nonempty(herdr.bin), `Project ${project.id} herdr.bin must be nonempty.`);
      check(["shared_worktree", "machine_local"].includes(herdr.workspace_mode), `Project ${project.id} herdr.workspace_mode must be shared_worktree or machine_local.`);
      if (machineLocal) {
        check(nonempty(herdr.working_directory), `Project ${project.id} machine_local Herdr requires a nonempty herdr.working_directory.`);
        check(path.posix.isAbsolute(herdr.working_directory) || path.win32.isAbsolute(herdr.working_directory), `Project ${project.id} herdr.working_directory must be absolute.`);
        check(["commit_only", "push_branch"].includes(policy.shipping), `Project ${project.id} machine_local Herdr supports only commit_only or push_branch shipping.`);
      }
    } else {
      check(project.herdr === undefined, `Project ${project.id} cannot configure herdr while runtime is local.`);
    }
    const timeout_ms = project.timeout_ms ?? 120 * 60_000;
    check(Number.isInteger(timeout_ms) && timeout_ms > 0, "timeout_ms must be positive.");
    const self_hosting = project.self_hosting ?? null;
    if (self_hosting !== null) {
      check(!machineLocal, "Machine-local Herdr projects cannot use local self_hosting worktree controls.");
      check(self_hosting && typeof self_hosting === "object" && !Array.isArray(self_hosting), "self_hosting must be an object.");
      check(self_hosting.isolated_worktree === true, "Self-hosted projects must require an isolated worktree.");
      check(self_hosting.restart_after_delivery === false, "Self-hosted projects cannot restart the live service during delivery.");
      check(max_concurrent_runs === 1, "Self-hosted projects must initially use max_concurrent_runs: 1.");
      check(!["merge_to_main", "deploy"].includes(policy.shipping), "Self-hosted projects cannot auto-merge or deploy.");
    }
    check(project.context_sources === undefined || (Array.isArray(project.context_sources) && project.context_sources.every((source) => typeof source === "string")), "context_sources must be file paths.");
    const suppliedAgent = project.agent ?? {};
    check(suppliedAgent && typeof suppliedAgent === "object" && !Array.isArray(suppliedAgent), "agent must be an object.");
    const agent = {
      default_role: "auto",
      allowed_roles: [...agentRoleIds],
      context_sources: {},
      skill_sources: {},
      ...(suppliedAgent ?? {}),
    };
    check(agent.default_role === "auto" || agentRoleIds.includes(agent.default_role), "Unknown default agent role.");
    check(Array.isArray(agent.allowed_roles) && agent.allowed_roles.length > 0 && agent.allowed_roles.every((role) => agentRoleIds.includes(role)), "allowed_roles must contain installed agent roles.");
    check(new Set(agent.allowed_roles).size === agent.allowed_roles.length, "allowed_roles must be unique.");
    if (agent.default_role !== "auto") check(agent.allowed_roles.includes(agent.default_role), "default_role must be allowed.");
    for (const [field, mapping] of [["context_sources", agent.context_sources], ["skill_sources", agent.skill_sources]]) {
      check(mapping && typeof mapping === "object" && !Array.isArray(mapping), `agent.${field} must be a role mapping.`);
      for (const [role, sources] of Object.entries(mapping)) {
        check(agentRoleIds.includes(role), `Unknown role in agent.${field}: ${role}`);
        check(Array.isArray(sources) && sources.every(nonempty), `agent.${field}.${role} must contain file paths.`);
      }
    }
    if (!repository) {
      check((project.context_sources ?? []).length === 0, `Project ${project.id} cannot use local context_sources without a local repository.`);
      check(Object.values(agent.context_sources).every((sources) => sources.length === 0), `Project ${project.id} cannot use local agent context_sources without a local repository.`);
      check(Object.values(agent.skill_sources).every((sources) => sources.length === 0), `Project ${project.id} cannot use local agent skill_sources without a local repository.`);
    }
    const context_limits = {
      max_files: 16,
      max_file_bytes: 65_536,
      max_total_bytes: 262_144,
      ...(project.context_limits ?? {}),
    };
    check(Number.isInteger(context_limits.max_files) && context_limits.max_files > 0 && context_limits.max_files <= 64, "context_limits.max_files must be 1–64.");
    check(Number.isInteger(context_limits.max_file_bytes) && context_limits.max_file_bytes > 0 && context_limits.max_file_bytes <= 1_000_000, "context_limits.max_file_bytes must be bounded.");
    check(Number.isInteger(context_limits.max_total_bytes) && context_limits.max_total_bytes > 0 && context_limits.max_total_bytes <= 2_000_000, "context_limits.max_total_bytes must be bounded.");
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
      runtime, ...(herdr ? { herdr } : {}), timeout_ms, remote: project.remote ?? "origin", base_ref: project.base_ref ?? "HEAD",
      agent, context_limits, ...(self_hosting ? { self_hosting } : {}),
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
  check(raw.triage === undefined || (raw.triage && typeof raw.triage === "object" && !Array.isArray(raw.triage)), "triage must be an object.");
  for (const key of Object.keys(raw.triage ?? {})) check(["max_per_tick", "max_concurrent", "base_backoff_ms", "max_backoff_ms"].includes(key), `Unknown triage setting: ${key}`);
  const triage = {
    max_per_tick: 1,
    max_concurrent: 1,
    base_backoff_ms: 30_000,
    max_backoff_ms: 60 * 60_000,
    ...(raw.triage ?? {}),
  };
  check(Number.isInteger(triage.max_per_tick) && triage.max_per_tick > 0 && triage.max_per_tick <= 100, "triage.max_per_tick must be 1–100.");
  check(Number.isInteger(triage.max_concurrent) && triage.max_concurrent > 0 && triage.max_concurrent <= 8, "triage.max_concurrent must be 1–8.");
  check(Number.isInteger(triage.base_backoff_ms) && triage.base_backoff_ms > 0, "triage.base_backoff_ms must be positive.");
  check(Number.isInteger(triage.max_backoff_ms) && triage.max_backoff_ms >= triage.base_backoff_ms, "triage.max_backoff_ms must be at least the base backoff.");
  return { projects, decision, max_jobs_per_run, triage, filename: absolute };
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

export function projectContext(project, { role } = {}) {
  const sources = [...(project.context_sources ?? []), ...(role ? project.agent?.context_sources?.[role] ?? [] : [])];
  const uniqueSources = [...new Set(sources)];
  check(uniqueSources.length <= project.context_limits.max_files, `Project context exceeds ${project.context_limits.max_files} files.`);
  let total = 0;
  return { ...project, context: uniqueSources.map((relative) => {
    const filename = fs.realpathSync(path.resolve(project.repository, relative));
    const rel = path.relative(project.repository, filename);
    check(rel && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel), "Context source must remain inside repository.");
    const size = fs.statSync(filename).size;
    check(size <= project.context_limits.max_file_bytes, `Context file exceeds ${project.context_limits.max_file_bytes} bytes.`);
    total += size;
    check(total <= project.context_limits.max_total_bytes, `Project context exceeds ${project.context_limits.max_total_bytes} bytes.`);
    return { source: relative, text: fs.readFileSync(filename, "utf8") };
  }) };
}
