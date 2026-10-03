import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const stableMetricKey = (value) => typeof value === "string" && /^[a-z][a-z0-9_]*$/.test(value);
const stableReference = (value) => typeof value === "string" && /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/i.test(value);
const validTimestamp = (value) => nonempty(value) && Number.isFinite(Date.parse(value));
const captureId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function readinessReason(code, message) { return { code, message }; }

/**
 * Readiness is derived from one immutable Brief revision. References and
 * approval deliberately bind to that same revision so copying them forward
 * cannot silently authorize changed work.
 */
export function evaluateBriefReadiness(brief) {
  const reasons = [];
  if (!nonempty(brief.outcome)) reasons.push(readinessReason("missing_outcome", "Define the outcome this slice must produce."));
  if (!nonempty(brief.scope)) reasons.push(readinessReason("missing_scope", "Define the boundaries of this slice."));
  if (!Array.isArray(brief.acceptance_criteria) || !brief.acceptance_criteria.length) {
    reasons.push(readinessReason("missing_acceptance_criteria", "Add at least one observable acceptance criterion."));
  }
  if (!brief.project_id || brief.project_context?.id !== brief.project_id) {
    reasons.push(readinessReason("missing_project_context", "Assign valid project context before the Brief can become slice-ready."));
  } else if (brief.project_context.status !== "active") {
    reasons.push(readinessReason("inactive_project_context", `Project ${brief.project_id} is ${brief.project_context.status}; only active project context is slice-ready.`));
  }

  const decisions = Array.isArray(brief.decision_references) ? brief.decision_references : [];
  const staleDecisions = decisions.filter((reference) => reference.brief_revision !== brief.revision);
  if (staleDecisions.length) {
    reasons.push(readinessReason("stale_decision_references", `Refresh decision references for Brief revision ${brief.revision}: ${staleDecisions.map((reference) => reference.id).join(", ")}.`));
  }

  if (!brief.approval) reasons.push(readinessReason("missing_approval", `Approve Brief revision ${brief.revision}.`));
  else if (brief.approval.brief_revision !== brief.revision) {
    reasons.push(readinessReason("stale_approval", `Approval covers Brief revision ${brief.approval.brief_revision}, not current revision ${brief.revision}.`));
  }

  const requiredArtifacts = Array.isArray(brief.required_design_artifacts) ? brief.required_design_artifacts : [];
  const artifacts = Array.isArray(brief.design_artifacts) ? brief.design_artifacts : [];
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const missingArtifacts = requiredArtifacts.filter((id) => !artifactsById.has(id));
  if (missingArtifacts.length) {
    reasons.push(readinessReason("missing_design_artifacts", `Attach required design artifacts: ${missingArtifacts.join(", ")}.`));
  }
  const staleArtifacts = requiredArtifacts
    .map((id) => artifactsById.get(id))
    .filter((artifact) => artifact && artifact.brief_revision !== brief.revision);
  if (staleArtifacts.length) {
    reasons.push(readinessReason("stale_design_artifacts", `Refresh design artifacts for Brief revision ${brief.revision}: ${staleArtifacts.map((artifact) => artifact.id).join(", ")}.`));
  }
  return { ready: reasons.length === 0, evaluated_revision: brief.revision, reasons };
}

function withReadiness(brief) {
  const readiness = evaluateBriefReadiness(brief);
  return {
    ...brief,
    status: readiness.ready ? "slice_ready" : (brief.project_id ? "draft" : "needs_clarification"),
    readiness,
    execution_eligible: false,
  };
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeNewJson(filename, value) {
  const fd = fs.openSync(filename, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function validateBrief(brief, intake) {
  requireValue(brief && typeof brief === "object" && !Array.isArray(brief), "Brief must be an object.");
  requireValue(captureId(brief.id), "Brief requires a valid id.");
  requireValue(brief.intake_id === intake.id && brief.intake_revision === intake.revision, "Brief must reference its immutable Intake revision.");
  requireValue(Number.isInteger(brief.revision) && brief.revision > 0, "Brief revision must be a positive integer.");
  requireValue(brief.project_id === null || nonempty(brief.project_id), "Brief project_id must be null or nonempty.");
  requireValue(brief.outcome === null || nonempty(brief.outcome), "Brief outcome must be null or nonempty.");
  requireValue(brief.scope === null || nonempty(brief.scope), "Brief scope must be null or nonempty.");
  requireValue(Array.isArray(brief.acceptance_criteria) && brief.acceptance_criteria.every(nonempty), "Brief acceptance_criteria must contain nonempty descriptions.");
  requireValue(Array.isArray(brief.metric_keys) && brief.metric_keys.every(stableMetricKey), "Brief metric_keys are invalid.");
  requireValue(Array.isArray(brief.metrics) && brief.metrics.length === brief.metric_keys.length, "Brief metric context is incomplete.");
  requireValue(brief.metrics.every((metric, index) => metric?.key === brief.metric_keys[index]), "Brief metric context does not match its references.");
  for (const field of ["assumptions", "required_capabilities", "decision_ids", "decision_references", "required_design_artifacts", "design_artifacts"]) requireValue(Array.isArray(brief[field]), `Brief ${field} must be an array.`);
  requireValue(brief.decision_references.every((reference) => reference && stableReference(reference.id) && Number.isInteger(reference.brief_revision) && reference.brief_revision > 0), "Brief decision references are invalid.");
  requireValue(new Set(brief.decision_references.map((reference) => reference.id)).size === brief.decision_references.length, "Brief decision references must be unique.");
  requireValue(brief.decision_ids.length === brief.decision_references.length && brief.decision_ids.every((id, index) => id === brief.decision_references[index].id), "Brief decision_ids must match its decision references.");
  requireValue(brief.required_design_artifacts.every(stableReference) && new Set(brief.required_design_artifacts).size === brief.required_design_artifacts.length, "Brief required design artifacts are invalid.");
  requireValue(brief.design_artifacts.every((artifact) => artifact && stableReference(artifact.id) && nonempty(artifact.uri) && Number.isInteger(artifact.brief_revision) && artifact.brief_revision > 0), "Brief design artifacts are invalid.");
  requireValue(new Set(brief.design_artifacts.map((artifact) => artifact.id)).size === brief.design_artifacts.length, "Brief design artifacts must be unique.");
  requireValue(brief.approval === null || (brief.approval && Number.isInteger(brief.approval.brief_revision) && brief.approval.brief_revision > 0 && nonempty(brief.approval.actor) && validTimestamp(brief.approval.approved_at)), "Brief approval is invalid.");
  requireValue(["draft", "needs_clarification", "slice_ready"].includes(brief.status), "Brief status is invalid.");
  const readiness = evaluateBriefReadiness(brief);
  requireValue(brief.readiness?.evaluated_revision === brief.revision && brief.readiness?.ready === readiness.ready && JSON.stringify(brief.readiness.reasons) === JSON.stringify(readiness.reasons), "Brief readiness must match its current revision and material inputs.");
  requireValue(brief.status === (readiness.ready ? "slice_ready" : (brief.project_id ? "draft" : "needs_clarification")), "Brief status must match readiness.");
  requireValue(brief.execution_eligible === false, "Capture Briefs cannot create executable work.");
  requireValue(nonempty(brief.classification?.rationale), "Brief classification requires a visible rationale.");
  if (brief.project_id === null) {
    requireValue(brief.project_context === null && nonempty(brief.clarification) && brief.status === "needs_clarification", "An unassigned Brief requires a visible clarification reason.");
  } else {
    requireValue(brief.project_context?.id === brief.project_id, "Brief project context does not match its assignment.");
    for (const field of ["purpose", "success_state"]) requireValue(nonempty(brief.project_context[field]), `Brief project context requires ${field}.`);
    requireValue(brief.clarification === null, "An assigned Brief cannot require project clarification.");
  }
}

function validateCapture(capture) {
  requireValue(capture && typeof capture === "object" && !Array.isArray(capture), "Capture must be an object.");
  requireValue(capture.schema_version === 1, "Unsupported capture schema version.");
  const { intake, brief } = capture;
  requireValue(intake && typeof intake === "object" && !Array.isArray(intake), "Capture requires an Intake.");
  requireValue(captureId(intake.id), "Intake requires a valid id.");
  requireValue(intake.revision === 1 && nonempty(intake.text) && nonempty(intake.actor) && nonempty(intake.source), "Invalid immutable Intake.");
  validateBrief(brief, intake);
}

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
      requireValue(stableMetricKey(metric.key), `Invalid metric key: ${metric.key}`);
      requireValue(!keys.has(metric.key), `Duplicate metric key: ${metric.key}`);
      keys.add(metric.key);
      requireValue(["percent", "count", "duration", "currency", "score"].includes(metric.unit), "Invalid metric unit.");
      requireValue(["increase", "decrease", "maintain"].includes(metric.desired_direction), "Invalid metric direction.");
    }
    const requiredDesignArtifacts = project.required_design_artifacts ?? [];
    requireValue(Array.isArray(requiredDesignArtifacts) && requiredDesignArtifacts.every(stableReference), "Required design artifacts must contain stable identifiers.");
    requireValue(new Set(requiredDesignArtifacts).size === requiredDesignArtifacts.length, "Required design artifacts must be unique.");
    return { ...project, weight, max_concurrent_runs: concurrency, metric_definitions: metrics, required_design_artifacts: requiredDesignArtifacts };
  });
}

export function createCapture(input, projects) {
  requireValue(Array.isArray(projects), "Projects must be an array.");
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
  requireValue(Array.isArray(metricKeys), "metric_keys must be an array.");
  requireValue(metricKeys.every(stableMetricKey), "metric_keys must contain only stable lowercase keys.");
  requireValue(new Set(metricKeys).size === metricKeys.length, "metric_keys must not contain duplicates.");
  if (metricKeys.length) requireValue(project, "Metric references require an assigned project.");
  for (const key of metricKeys) {
    requireValue(project.metric_definitions.some((metric) => metric.key === key), `Unknown metric reference for project ${project.id}: ${key}`);
  }
  if (input.outcome !== undefined) requireValue(nonempty(input.outcome), "Invalid outcome.");
  if (input.scope !== undefined) requireValue(nonempty(input.scope), "Invalid scope.");
  requireValue(input.acceptance_criteria === undefined || (Array.isArray(input.acceptance_criteria) && input.acceptance_criteria.every(nonempty)), "acceptance_criteria must contain nonempty descriptions.");
  requireValue(input.decision_references === undefined || Array.isArray(input.decision_references), "decision_references must be an array.");
  requireValue(input.design_artifacts === undefined || Array.isArray(input.design_artifacts), "design_artifacts must be an array.");
  const now = new Date().toISOString();
  const base = { schema_version: 1, revision: 1, created_at: now, updated_at: now };
  const intake = { ...base, id: randomUUID(), text: input.text, source: input.source, actor: input.actor };
  const decisionReferences = (input.decision_references ?? []).map((reference) => structuredClone(reference));
  const designArtifacts = (input.design_artifacts ?? []).map((artifact) => structuredClone(artifact));
  const brief = withReadiness({
    ...base, id: randomUUID(), intake_id: intake.id, intake_revision: 1,
    project_id: project?.id ?? null,
    classification: {
      method: explicit ? "explicit" : "project-name-match",
      confidence: project ? (explicit ? 1 : 0.8) : 0,
      rationale: explicit ? "Project explicitly selected by submitter." : project ? "One project name matched; confidence is a heuristic, not a calibrated probability." : "No unique project name match; human clarification required.",
      candidate_ids: candidates.map((candidate) => candidate.id),
    },
    project_context: project ? structuredClone(project) : null,
    outcome: input.outcome ?? null, scope: input.scope ?? null,
    acceptance_criteria: structuredClone(input.acceptance_criteria ?? []), metric_keys: metricKeys,
    metrics: project ? metricKeys.map((key) => structuredClone(project.metric_definitions.find((metric) => metric.key === key))) : [],
    success_state: project?.success_state ?? null,
    assumptions: [], required_capabilities: [], decision_ids: decisionReferences.map((reference) => reference.id), decision_references: decisionReferences,
    required_design_artifacts: structuredClone(project?.required_design_artifacts ?? []), design_artifacts: designArtifacts,
    approval: input.approval ? structuredClone(input.approval) : null,
    clarification: project ? null : "Which project should this idea belong to?",
  });
  const capture = { schema_version: 1, intake, brief };
  validateCapture(capture);
  return capture;
}

export function saveCapture(directory, capture) {
  validateCapture(capture);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, capture.intake.id);
  requireValue(!fs.existsSync(target), `Intake already exists: ${capture.intake.id}`);
  const temporary = path.join(directory, `.${capture.intake.id}.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(temporary, { mode: 0o700 });
    const briefs = path.join(temporary, "briefs");
    fs.mkdirSync(briefs, { mode: 0o700 });
    writeNewJson(path.join(temporary, "intake.json"), capture.intake);
    writeNewJson(path.join(briefs, "000001.json"), capture.brief);
    syncDirectory(briefs);
    syncDirectory(temporary);
    // A directory rename publishes the Intake and initial Brief together, while
    // keeping their independently versioned records separate on disk.
    fs.renameSync(temporary, target);
    syncDirectory(directory);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return {
    directory: target,
    intake_file: path.join(target, "intake.json"),
    brief_file: path.join(target, "briefs", "000001.json"),
  };
}

export function loadCapture(directory, intakeId) {
  requireValue(captureId(intakeId), "Invalid intake id.");
  const target = path.join(directory, intakeId);
  const intake = JSON.parse(fs.readFileSync(path.join(target, "intake.json"), "utf8"));
  const filenames = fs.readdirSync(path.join(target, "briefs"))
    .filter((filename) => /^\d{6}\.json$/.test(filename))
    .sort();
  requireValue(filenames.length > 0, "Capture has no Brief revisions.");
  const brief_revisions = filenames.map((filename, index) => {
    const brief = JSON.parse(fs.readFileSync(path.join(target, "briefs", filename), "utf8"));
    validateBrief(brief, intake);
    requireValue(brief.revision === index + 1 && filename === `${String(brief.revision).padStart(6, "0")}.json`, "Brief revisions must be contiguous.");
    return brief;
  });
  return { schema_version: 1, intake, brief: brief_revisions.at(-1), brief_revisions };
}

export function appendBriefRevision(directory, intakeId, changes) {
  requireValue(changes && typeof changes === "object" && !Array.isArray(changes), "Brief changes must be an object.");
  const allowed = new Set(["outcome", "scope", "acceptance_criteria", "assumptions", "required_capabilities", "decision_references", "design_artifacts", "approval", "clarification"]);
  for (const key of Object.keys(changes)) requireValue(allowed.has(key), `Brief field cannot be revised directly: ${key}`);
  const capture = loadCapture(directory, intakeId);
  const revision = capture.brief.revision + 1;
  const changed = structuredClone(changes);
  if (changed.decision_references) changed.decision_ids = changed.decision_references.map((reference) => reference.id);
  const brief = withReadiness({
    ...capture.brief,
    ...changed,
    revision,
    updated_at: new Date().toISOString(),
  });
  validateBrief(brief, capture.intake);
  const briefs = path.join(directory, intakeId, "briefs");
  const filename = path.join(briefs, `${String(revision).padStart(6, "0")}.json`);
  const temporary = path.join(briefs, `.${randomUUID()}.tmp`);
  try {
    writeNewJson(temporary, brief);
    fs.linkSync(temporary, filename);
    syncDirectory(briefs);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return brief;
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
  const files = saveCapture(path.resolve(options["--state-dir"], "intakes"), capture);
  return { type: "intake.captured", file: files.intake_file, ...files, intake_id: capture.intake.id, brief: capture.brief };
}
