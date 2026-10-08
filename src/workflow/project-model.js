import { digest } from "../storage/repository.js";

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export function projectSlug(name) {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `project-${digest(String(name ?? "project")).slice(0, 8)}`;
}

export function resolveProjectIdentity(data, configuredProjects, name, metadata = {}) {
  if (!nonempty(name) || name.trim().toLowerCase() === "unassigned") return null;
  const normalized = name.trim();
  const configured = (configuredProjects ?? []).find((project) =>
    project.id.toLowerCase() === normalized.toLowerCase() || project.name.toLowerCase() === normalized.toLowerCase());
  let id = configured?.id ?? projectSlug(normalized);
  const occupied = data.projects?.[id];
  if (!configured && occupied?.name && occupied.name.toLowerCase() !== normalized.toLowerCase()) {
    id = `${id.slice(0, 55)}-${digest(normalized.toLowerCase()).slice(0, 8)}`;
  }
  data.projects ??= {};
  data.projects[id] = {
    ...data.projects[id],
    id,
    name: configured?.name ?? data.projects[id]?.name ?? normalized,
    configured: Boolean(configured),
    repository: configured?.repository ?? data.projects[id]?.repository ?? null,
    repository_required: configured?.repository_required ?? data.projects[id]?.repository_required ?? false,
    ...metadata,
  };
  return data.projects[id];
}

// Compatibility migration: promote the old third state into ordinary project
// assignments while retaining its source record for audit and rollback.
export function promoteProjectCandidates(store, configuredProjects = []) {
  return store.change((data) => {
    let assigned = 0;
    for (const item of Object.values(data.items ?? {})) {
      if (!item.project_candidate_id || item.project_id) continue;
      const legacy = data.project_candidates?.[item.project_candidate_id];
      const project = resolveProjectIdentity(data, configuredProjects, legacy?.name, {
        source_system: legacy?.source_system ?? null,
        first_seen_at: legacy?.first_seen_at ?? null,
      });
      if (!project) {
        item.legacy_project_candidate_id = item.project_candidate_id;
        delete item.project_candidate_id;
        continue;
      }
      item.project_id = project.id;
      item.legacy_project_candidate_id = item.project_candidate_id;
      delete item.project_candidate_id;
      assigned += 1;
    }
    data.system_metadata ??= {};
    data.system_metadata.project_model_migration = {
      version: 1,
      assigned,
      retained_legacy_records: Object.keys(data.project_candidates ?? {}).length,
      completed_at: new Date().toISOString(),
    };
    return data.system_metadata.project_model_migration;
  });
}
