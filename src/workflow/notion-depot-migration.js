import { createHash } from "node:crypto";
import { digest } from "../storage/repository.js";
import { record } from "./state.js";

export const LEGACY_FIELDS = [
  "Roundhouse ID",
  "Item",
  "Project",
  "Project Confidence",
  "Priority",
  "Raw Intake",
  "Normalized Brief",
  "Outcome",
  "Acceptance Criteria",
  "Decisions Needed",
  "Work Type",
  "Intake Source",
  "Status",
  "Workflow State",
  "Agent Ready",
  "Slice Ready",
  "Needs UX",
  "Roundhouse Job ID",
  "Delivery Summary",
  "Relevant Project KPI",
  "Created",
  "Updated",
];

const completedStates = new Set(["complete", "completed", "done", "shipped", "closed", "delivered"]);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

function textValue(value) {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n");
  if (value.select) return textValue(value.select.name);
  if (value.status) return textValue(value.status.name);
  if (value.date) return textValue(value.date.start);
  if (value.url) return textValue(value.url);
  if (value.number !== undefined) return textValue(value.number);
  if (value.checkbox !== undefined) return textValue(value.checkbox);
  if (value.formula) return textValue(value.formula);
  if (value.string !== undefined) return textValue(value.string);
  if (value.boolean !== undefined) return textValue(value.boolean);
  if (value.rich_text || value.title) return textValue(value.rich_text ?? value.title);
  if (value.plain_text !== undefined) return textValue(value.plain_text);
  if (value.text?.content !== undefined) return textValue(value.text.content);
  if (value.name !== undefined) return textValue(value.name);
  return "";
}

function properties(row) {
  return row?.properties && typeof row.properties === "object" && !Array.isArray(row.properties)
    ? row.properties
    : row;
}

function field(row, name) {
  const props = properties(row);
  if (!props || typeof props !== "object" || Array.isArray(props)) return "";
  const key = Object.keys(props).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? textValue(props[key]).trim() : "";
}

function first(row, names) {
  for (const name of names) {
    const value = field(row, name);
    if (value) return value;
  }
  return "";
}

function notionId(value) {
  const match = String(value ?? "").replaceAll("-", "").match(/[a-f0-9]{32}/i)?.[0];
  return match ? match.toLowerCase() : "";
}

function sourceIdentity(row) {
  const combined = first(row, ["Notion Page URL / Source ID"]);
  const explicitUrl = first(row, ["Notion Page URL", "Source Page URL", "Page URL", "url"])
    || (nonempty(row?.url) ? row.url.trim() : "");
  const url = explicitUrl || (/^https?:\/\//i.test(combined) ? combined : "");
  const sourceId = first(row, ["Notion Source ID", "Source ID", "Page ID", "id"])
    || (nonempty(row?.id) ? row.id.trim() : "")
    || combined
    || notionId(url);
  if (!url && !sourceId) throw new Error("A Notion page URL or source ID is required.");
  return { source_id: notionId(sourceId) || sourceId, source_page_url: url || null };
}

function timestamp(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
}

function normalizedLegacy(row) {
  return Object.fromEntries(LEGACY_FIELDS.map((name) => [name, field(row, name)]));
}

function sourceRecordDigest(source, legacy) {
  return digest({ source_id: source.source_id, source_page_url: source.source_page_url, fields: legacy });
}

function sourceMatches(item, source) {
  const provenances = [item.provenance, ...(item.legacy_sources ?? [])].filter(Boolean);
  return provenances.some((candidate) => candidate.source_system === "notion"
    && ((source.source_id && candidate.source_id === source.source_id)
      || (source.source_page_url && candidate.source_page_url === source.source_page_url)))
    || (source.source_id && item.input?.notion?.page_id === notionId(source.source_id))
    || (source.source_page_url && item.input?.source === source.source_page_url);
}

function findNativeReference(data, reference) {
  if (!reference) return [];
  const matches = [];
  if (data.items[reference]) matches.push(data.items[reference]);
  if (data.jobs[reference]?.parent_id && data.items[data.jobs[reference].parent_id]) matches.push(data.items[data.jobs[reference].parent_id]);
  return [...new Map(matches.map((item) => [item.id, item])).values()];
}

function projectMatch(label, configuredProjects) {
  if (!label || label.toLowerCase() === "unassigned") return null;
  const lowered = label.toLowerCase();
  const matches = configuredProjects.filter((project) => project.id.toLowerCase() === lowered || project.name.toLowerCase() === lowered);
  return matches.length === 1 ? matches[0] : null;
}

function candidate(data, label, source, at) {
  if (!label || label.toLowerCase() === "unassigned") return null;
  data.project_candidates ??= {};
  const id = `notion-${digest(label.toLowerCase()).slice(0, 16)}`;
  const existing = data.project_candidates[id];
  if (existing) {
    if (!existing.source_ids.includes(source.source_id)) existing.source_ids.push(source.source_id);
    existing.record_count = existing.source_ids.length;
    return existing;
  }
  const value = {
    id,
    name: label,
    status: "candidate",
    executable: false,
    source_system: "notion",
    first_seen_at: at,
    source_ids: [source.source_id],
    record_count: 1,
  };
  data.project_candidates[id] = value;
  return value;
}

function isCompleted(legacy) {
  return [legacy.Status, legacy["Workflow State"]]
    .map((value) => value.toLowerCase().trim())
    .some((value) => completedStates.has(value));
}

function explicitlyNeedsDecision(legacy) {
  return [legacy.Status, legacy["Workflow State"]]
    .map((value) => value.toLowerCase().trim())
    .some((value) => value === "needs decisions" || value === "needs decision" || value === "needs clarification");
}

function priorityRank(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const p = normalized.match(/^p([0-9]+)$/);
  if (p) return Number(p[1]);
  return { urgent: 0, critical: 0, high: 1, medium: 2, normal: 2, low: 3 }[normalized] ?? 100;
}

function rowResult(source, item, action, detail) {
  return { source_id: source.source_id, source_page_url: source.source_page_url, item_id: item?.id ?? null, action, ...(detail ? { detail } : {}) };
}

function initialReport(total, exportDigest) {
  return {
    total,
    imported_history: 0,
    imported_pending: 0,
    reconciled: 0,
    skipped_already_imported: 0,
    conflicts: 0,
    errors: 0,
    export_digest: exportDigest,
    records: [],
  };
}

function replayReport(entry) {
  const report = initialReport(entry.count, entry.digest);
  for (const previous of entry.records ?? []) {
    if (["error", "conflict"].includes(previous.action)) {
      report[`${previous.action}s`] += 1;
      report.records.push(previous);
    } else {
      report.skipped_already_imported += 1;
      report.records.push({ ...previous, action: "already_imported" });
    }
  }
  report.cutover_completed_at = entry.completed_at;
  return report;
}

export function exportRows(value) {
  if (Array.isArray(value)) return value;
  for (const key of ["rows", "pages", "records", "items", "results"]) if (Array.isArray(value?.[key])) return value[key];
  throw new Error("Notion Depot export must be an array or contain rows/pages/records/items/results.");
}

export function exportFileDigest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function importNotionDepot({ store, exportData, exportDigest, configuredProjects = [], now = () => new Date().toISOString() }) {
  const rows = exportRows(exportData);
  if (!nonempty(exportDigest)) throw new Error("An export digest is required.");
  const existingCutover = store.read().system_metadata?.notion_depot_cutover;
  const existingExport = existingCutover?.exports?.find((entry) => entry.digest === exportDigest);
  if (existingExport) return replayReport(existingExport);

  return store.change((data) => {
    data.project_candidates ??= {};
    data.system_metadata ??= {};
    const at = now();
    const report = initialReport(rows.length, exportDigest);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      let source;
      try {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Row must be an object.");
        source = sourceIdentity(row);
        const legacy = normalizedLegacy(row);
        const recordDigest = sourceRecordDigest(source, legacy);
        const bySource = Object.values(data.items).filter((item) => sourceMatches(item, source));
        const reference = legacy["Roundhouse Job ID"];
        const byReference = findNativeReference(data, reference);
        const matches = [...new Map([...bySource, ...byReference].map((item) => [item.id, item])).values()];
        if (matches.length > 1) {
          report.conflicts += 1;
          report.records.push(rowResult(source, null, "conflict", `Source identity and Roundhouse reference resolve to multiple items: ${matches.map((item) => item.id).join(", ")}`));
          continue;
        }
        if (matches.length === 1) {
          const item = matches[0];
          const prior = [item.provenance, ...(item.legacy_sources ?? [])].find((candidate) => candidate?.source_system === "notion"
            && candidate.source_record_digest && ((source.source_id && candidate.source_id === source.source_id)
              || (source.source_page_url && candidate.source_page_url === source.source_page_url)));
          if (prior && prior.source_record_digest !== recordDigest) {
            report.conflicts += 1;
            report.records.push(rowResult(source, item, "conflict", "The Notion source record changed after import; native history was not overwritten."));
            continue;
          }
          if (prior) {
            report.skipped_already_imported += 1;
            report.records.push(rowResult(source, item, "already_imported"));
            continue;
          }
          const provenance = {
            source_system: "notion",
            source: "Roundhouse Depot prototype",
            source_id: source.source_id,
            source_page_url: source.source_page_url,
            source_record_digest: recordDigest,
            export_digest: exportDigest,
            imported_at: at,
            legacy_roundhouse_id: legacy["Roundhouse ID"] || null,
            reconciled: true,
          };
          item.legacy_sources ??= [];
          item.legacy_sources.push(provenance);
          item.legacy_depot_records ??= [];
          item.legacy_depot_records.push(legacy);
          report.reconciled += 1;
          report.records.push(rowResult(source, item, "reconciled"));
          continue;
        }

        const configured = projectMatch(legacy.Project, configuredProjects);
        const projectCandidate = configured ? null : candidate(data, legacy.Project, source, at);
        const completed = isCompleted(legacy);
        const id = `notion-${digest(source.source_id || source.source_page_url).slice(0, 24)}`;
        if (data.items[id]) {
          report.conflicts += 1;
          report.records.push(rowResult(source, data.items[id], "conflict", "Deterministic import ID is already occupied by an unrelated item."));
          continue;
        }
        const rawIntake = legacy["Raw Intake"] || legacy["Normalized Brief"] || legacy.Item || "Imported Notion Depot record";
        const created = timestamp(legacy.Created, at);
        const updated = timestamp(legacy.Updated, created);
        const state = completed ? "Imported History" : "Imported Pending";
        const provenance = {
          source_system: "notion",
          source: "Roundhouse Depot prototype",
          source_id: source.source_id,
          source_page_url: source.source_page_url,
          source_record_digest: recordDigest,
          export_digest: exportDigest,
          imported_at: at,
          legacy_roundhouse_id: legacy["Roundhouse ID"] || null,
          reconciled: false,
        };
        const decisionsNeeded = legacy["Decisions Needed"];
        const questions = !completed && decisionsNeeded && explicitlyNeedsDecision(legacy) ? [{
          id: `notion-question-${digest(source.source_id || source.source_page_url).slice(0, 20)}`,
          decision_id: null,
          decision_key: `notion-import:${source.source_id}:decisions-needed`,
          item_id: id,
          item_revision: 1,
          revision: 1,
          kind: "imported_decision",
          prompt: decisionsNeeded,
          status: "open",
          created_at: at,
          updated_at: at,
        }] : [];
        const item = record(id, {
          state,
          created_at: created,
          updated_at: updated,
          imported_at: at,
          input: {
            schema_version: 1,
            text: rawIntake,
            source: source.source_page_url ?? `notion:${source.source_id}`,
            actor: "notion-depot-migration",
            ...(configured ? { project_id: configured.id } : {}),
            ...(legacy.Project ? { project_hint: legacy.Project } : {}),
          },
          project_id: configured?.id ?? null,
          project_candidate_id: projectCandidate?.id ?? null,
          priority: legacy.Priority || null,
          priority_rank: priorityRank(legacy.Priority),
          execution_eligible: false,
          requires_reevaluation: !completed,
          provenance,
          legacy_depot: legacy,
          clarifications: [],
          questions,
          decision: null,
          job_ids: [],
          history: [{ from: null, to: state, reason: completed
            ? "Imported as non-executable Notion Depot history."
            : "Imported pending explicit Roundhouse re-evaluation; execution is disabled.", at }],
        });
        data.items[id] = item;
        if (completed) report.imported_history += 1;
        else report.imported_pending += 1;
        report.records.push(rowResult(source, item, completed ? "imported_history" : "imported_pending"));
      } catch (error) {
        report.errors += 1;
        report.records.push({ row: index + 1, source_id: source?.source_id ?? null, action: "error", detail: error.message });
      }
    }

    const cutover = data.system_metadata.notion_depot_cutover ?? {
      completed: true,
      completed_at: at,
      source_system: "notion",
      source: "Roundhouse Depot prototype",
      authoritative_system: "roundhouse",
      notion_mode: "archive_only",
      exports: [],
    };
    const entry = { digest: exportDigest, count: rows.length, completed_at: at, records: structuredClone(report.records),
      summary: { imported_history: report.imported_history, imported_pending: report.imported_pending, reconciled: report.reconciled,
        skipped_already_imported: report.skipped_already_imported, conflicts: report.conflicts, errors: report.errors } };
    cutover.exports.push(entry);
    cutover.last_export_digest = exportDigest;
    cutover.last_export_count = rows.length;
    cutover.last_completed_at = at;
    data.system_metadata.notion_depot_cutover = cutover;
    report.cutover_completed_at = cutover.completed_at;
    return report;
  });
}
