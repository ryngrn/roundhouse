import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export function loadProjects(filename) {
  const data = YAML.parse(fs.readFileSync(filename, "utf8"));
  requireValue(Array.isArray(data?.projects), "Manifest must contain a projects array.");
  const ids = new Set();
  return data.projects.map((project) => {
    requireValue(project && typeof project === "object", "Invalid project.");
    for (const field of ["id", "name", "purpose", "success_state"]) {
      requireValue(nonempty(project[field]), `Project requires ${field}.`);
    }
    requireValue(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.id), "Project id must be a stable lowercase slug.");
    requireValue(!ids.has(project.id), `Duplicate project id: ${project.id}`);
    ids.add(project.id);
    requireValue(["active", "paused", "archived"].includes(project.status), "Invalid project status.");
    const weight = project.weight ?? 1;
    const concurrency = project.max_concurrent_runs ?? 1;
    requireValue(Number.isFinite(weight) && weight > 0, "Project weight must be positive.");
    requireValue(Number.isInteger(concurrency) && concurrency > 0, "Project concurrency must be a positive integer.");
    const metrics = project.metric_definitions ?? [];
    requireValue(Array.isArray(metrics), "Metric definitions must be an array.");
    const keys = new Set();
    for (const metric of metrics) {
      requireValue(metric && ["key", "name", "description"].every((key) => nonempty(metric[key])), "Invalid metric definition.");
      requireValue(!keys.has(metric.key), `Duplicate metric key: ${metric.key}`);
      keys.add(metric.key);
      requireValue(["percent", "count", "duration", "currency", "score"].includes(metric.unit), "Invalid metric unit.");
      requireValue(["increase", "decrease", "maintain"].includes(metric.desired_direction), "Invalid metric direction.");
    }
    return { ...project, weight, max_concurrent_runs: concurrency, metric_definitions: metrics };
  });
}

export function createCapture(input, projects) {
  requireValue(input && typeof input === "object" && !Array.isArray(input), "Input must be an object.");
  requireValue(nonempty(input.text), "Input requires nonempty text.");
  requireValue(nonempty(input.actor), "Input requires an actor.");
  requireValue(nonempty(input.source), "Input requires a source reference.");
  if (input.project_id !== undefined) requireValue(nonempty(input.project_id), "Invalid project_id.");
  const explicit = input.project_id !== undefined;
  const candidates = projects.filter((project) => {
    if (explicit) return project.id === input.project_id;
    // Conservative name matching, not a semantic classifier. Multiple matches stay unassigned.
    const escaped = project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(input.text);
  });
  requireValue(!explicit || candidates.length === 1, `Unknown project: ${input.project_id}`);
  const project = candidates.length === 1 ? candidates[0] : null;
  const metricKeys = input.metric_keys ?? [];
  requireValue(Array.isArray(metricKeys) && metricKeys.every(nonempty), "metric_keys must be an array of strings.");
  requireValue(metricKeys.every((key) => project?.metric_definitions.some((metric) => metric.key === key)), "Metric references require a matching assigned project definition.");
  if (input.outcome !== undefined) requireValue(nonempty(input.outcome), "Invalid outcome.");
  const now = new Date().toISOString();
  const base = { schema_version: 1, revision: 1, created_at: now, updated_at: now };
  const intake = { ...base, id: randomUUID(), text: input.text, source: input.source, actor: input.actor };
  const brief = {
    ...base, id: randomUUID(), intake_id: intake.id, intake_revision: 1,
    project_id: project?.id ?? null,
    classification: {
      method: explicit ? "explicit" : "project-name-match",
      confidence: project ? (explicit ? 1 : 0.8) : 0,
      rationale: explicit ? "Project explicitly selected by submitter." : project ? "One project name matched; confidence is a heuristic, not a calibrated probability." : "No unique project name match; human clarification required.",
      candidate_ids: candidates.map((candidate) => candidate.id),
    },
    project_context: project ? structuredClone(project) : null,
    outcome: input.outcome ?? null, metric_keys: metricKeys,
    success_state: project?.success_state ?? null,
    assumptions: [], required_capabilities: [], decision_ids: [],
    clarification: project ? null : "Which project should this idea belong to?",
    status: project ? "draft" : "needs_clarification",
  };
  return { schema_version: 1, intake, brief };
}

export function saveCapture(directory, capture) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${capture.intake.id}.json`);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(capture, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // Publish the complete record atomically without overwriting an existing intake.
    fs.linkSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return target;
}

export function captureCommand(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    requireValue(["--input", "--manifest", "--state-dir"].includes(key) && argv[i + 1] && !argv[i + 1].startsWith("--") && !options[key], `Invalid capture option: ${key}`);
    options[key] = argv[i + 1];
  }
  for (const key of ["--input", "--manifest", "--state-dir"]) requireValue(options[key], `capture requires ${key}.`);
  const projects = loadProjects(options["--manifest"]);
  const input = JSON.parse(fs.readFileSync(options["--input"], "utf8"));
  const capture = createCapture(input, projects);
  const file = saveCapture(path.resolve(options["--state-dir"], "intakes"), capture);
  return { type: "intake.captured", file, intake_id: capture.intake.id, brief: capture.brief };
}
