import { digest } from "../storage/repository.js";

const priorityWeight = (rank) => {
  if (rank <= 0) return 8;
  if (rank === 1) return 4;
  if (rank === 2) return 2;
  return 1;
};

export const priorityRank = (item) => Number.isFinite(item.priority_rank) ? item.priority_rank : 100;

export function triageFingerprint(item, data, config, store) {
  const selected = item.selected_project ?? item.input?.project_id ?? item.project_id ?? null;
  const project = config.projects.find((candidate) => candidate.id === selected) ?? null;
  return digest({
    project: project ? {
      id: project.id,
      status: project.status,
      repository: project.repository,
      runtime: project.runtime,
      executor: project.executor,
      policy: project.policy,
      verification: project.verification,
      max_concurrent_runs: project.max_concurrent_runs,
    } : null,
    project_runtime: selected ? data.projects?.[selected] ?? null : null,
    project_candidate: item.project_candidate_id ? data.project_candidates?.[item.project_candidate_id] ?? null : null,
    dependency_revisions: data.system_metadata?.triage_dependency_revisions ?? {},
    storage: { kind: store.kind, shared: store.shared },
  });
}

export function isTriageCandidate(item, { now, fingerprint }) {
  if (["Imported History", "Archived", "Reconciled", "Shipped"].includes(item.state) || item.job_ids?.length) return false;
  const next = item.triage?.next_attempt_at ? Date.parse(item.triage.next_attempt_at) : 0;
  if (Number.isFinite(next) && next > now) return false;
  if (item.state === "Imported Pending" || item.state === "Depot" || item.awaiting_decision) return true;
  if (item.state !== "Blocked") return false;
  if (item.triage?.interrupted) return Boolean(item.triage.retry_requested_at);
  return Boolean(item.triage?.retry_requested_at) || item.triage?.blocked_fingerprint !== fingerprint;
}

export function selectTriageCandidates(data, config, store, { now = Date.now(), limit = Infinity, projectId } = {}) {
  return Object.values(data.items)
    .map((item) => ({ item, fingerprint: triageFingerprint(item, data, config, store) }))
    .filter(({ item, fingerprint }) => isTriageCandidate(item, { now, fingerprint }))
    .filter(({ item }) => !projectId || !item.input?.project_id || item.input.project_id === projectId)
    .sort((a, b) => {
      const aRank = priorityRank(a.item);
      const bRank = priorityRank(b.item);
      const aTurn = (a.item.triage?.last_selected_sequence ?? 0) / priorityWeight(aRank);
      const bTurn = (b.item.triage?.last_selected_sequence ?? 0) / priorityWeight(bRank);
      return aTurn - bTurn || aRank - bRank
        || String(a.item.created_at).localeCompare(String(b.item.created_at)) || a.item.id.localeCompare(b.item.id);
    })
    .slice(0, limit);
}

export function triageBackoff(config, failures) {
  return Math.min(config.triage.max_backoff_ms, config.triage.base_backoff_ms * (2 ** Math.max(0, failures - 1)));
}

export function exactReconciliationTarget(data, item, targetId) {
  if (!targetId || targetId === item.id) return null;
  const target = data.items[targetId] ?? (data.jobs[targetId]?.parent_id ? data.items[data.jobs[targetId].parent_id] : null);
  if (!target) return null;
  const references = new Set([
    item.input?.metadata?.duplicate_of,
    item.input?.metadata?.native_item_id,
    item.input?.metadata?.roundhouse_item_id,
    item.provenance?.legacy_roundhouse_id,
    item.legacy_depot?.["Roundhouse Job ID"],
  ].filter(Boolean));
  if (references.has(target.id) || [...references].some((reference) => data.jobs[reference]?.parent_id === target.id)) return target;
  const sources = [item.provenance, ...(item.legacy_sources ?? [])].filter(Boolean);
  const targetSources = [target.provenance, ...(target.legacy_sources ?? [])].filter(Boolean);
  return sources.some((source) => targetSources.some((candidate) =>
    source.source_system && source.source_system === candidate.source_system && source.source_id && source.source_id === candidate.source_id,
  )) ? target : null;
}
