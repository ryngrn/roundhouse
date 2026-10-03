import path from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../storage/repository.js";

const stableId = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const actionKinds = new Set(["create", "connect", "inspect", "map_workspace"]);
const lifecycleStates = new Set(["provisioning", "connected", "ready", "reconciliation_required", "disconnected"]);

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string.`);
  return value.trim();
}

function clone(value) {
  return structuredClone(value);
}

/**
 * Provider-neutral identity retained by Roundhouse. Provider account,
 * installation, owner, and API-specific fields belong to the adapter and are
 * deliberately not accepted here.
 */
export function repositoryIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Repository identity must be an object.");
  const adapter_id = requiredString(value.adapter_id, "Repository identity adapter_id");
  if (!stableId.test(adapter_id)) throw new Error("Repository identity adapter_id must be a stable lowercase identifier.");
  const provider_repository_id = requiredString(value.provider_repository_id, "Repository identity provider_repository_id");
  const identity = { adapter_id, provider_repository_id };
  if (value.canonical_url != null) identity.canonical_url = requiredString(value.canonical_url, "Repository identity canonical_url");
  if (value.display_name != null) identity.display_name = requiredString(value.display_name, "Repository identity display_name");
  return identity;
}

export class RepositoryAdapter {
  constructor({ id }) {
    if (new.target === RepositoryAdapter) throw new TypeError("RepositoryAdapter is abstract.");
    if (!stableId.test(id ?? "")) throw new Error("Repository adapter requires a stable lowercase id.");
    this.id = id;
  }

  create() { throw new Error("create() is not implemented."); }
  connect() { throw new Error("connect() is not implemented."); }
  inspect() { throw new Error("inspect() is not implemented."); }
}

export class RepositoryAdapterRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    if (!adapter || !stableId.test(adapter.id ?? "")) throw new Error("Repository adapter requires a stable lowercase id.");
    for (const method of ["create", "connect", "inspect"]) {
      if (typeof adapter[method] !== "function") throw new Error(`Repository adapter ${adapter.id} must implement ${method}().`);
    }
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate repository adapter: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  require(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Repository adapter is not installed: ${id}`);
    return adapter;
  }
}

function ensureProvisioningState(data) {
  data.repositories ??= {};
  data.repository_actions ??= {};
  data.workspace_mappings ??= {};
  return data;
}

function actionResult(action, data) {
  return {
    action: clone(action),
    repository: action.repository_id ? clone(data.repositories[action.repository_id] ?? null) : null,
  };
}

/**
 * Persists intent before invoking an adapter. An interrupted or uncertain
 * mutating operation is never replayed: its durable action remains available
 * for inspect/reconciliation with the original request digest and provenance.
 */
export class RepositoryProvisioner {
  constructor({ store, adapters, clock = () => Date.now(), id = () => randomUUID() }) {
    if (!store || typeof store.read !== "function" || typeof store.change !== "function") throw new Error("RepositoryProvisioner requires a durable store.");
    this.store = store;
    this.adapters = adapters instanceof RepositoryAdapterRegistry ? adapters : new RepositoryAdapterRegistry(adapters);
    this.clock = clock;
    this.id = id;
  }

  now() { return new Date(this.clock()).toISOString(); }

  async create({ adapter_id, request, idempotency_key, actor = null }) {
    return this.#perform({ kind: "create", adapter_id, request, idempotency_key, actor, invoke: (adapter) => adapter.create(clone(request)) });
  }

  async connect({ adapter_id, request, idempotency_key, actor = null }) {
    return this.#perform({ kind: "connect", adapter_id, request, idempotency_key, actor, invoke: (adapter) => adapter.connect(clone(request)) });
  }

  async inspect({ repository_id, idempotency_key, actor = null }) {
    const snapshot = ensureProvisioningState(await this.store.read());
    const repository = snapshot.repositories[repository_id];
    if (!repository) throw new Error(`Unknown repository: ${repository_id}`);
    return this.#perform({ kind: "inspect", adapter_id: repository.identity.adapter_id,
      request: { repository_id, identity: repository.identity }, repository_id, idempotency_key, actor,
      invoke: (adapter) => adapter.inspect(clone(repository.identity)) });
  }

  async mapWorkspace({ repository_id, project_id, workspace, purpose = "execution", idempotency_key, actor = null }) {
    requiredString(repository_id, "repository_id");
    requiredString(project_id, "project_id");
    const absoluteWorkspace = path.resolve(requiredString(workspace, "workspace"));
    const result = await this.#perform({ kind: "map_workspace", adapter_id: "roundhouse-local",
      request: { repository_id, project_id, workspace: absoluteWorkspace, purpose }, repository_id,
      idempotency_key, actor, invoke: async () => ({ workspace: absoluteWorkspace }) });
    return result;
  }

  async #perform({ kind, adapter_id, request, repository_id = null, idempotency_key, actor, invoke }) {
    if (!actionKinds.has(kind)) throw new Error(`Unknown repository action: ${kind}`);
    requiredString(idempotency_key, "Repository action idempotency_key");
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Repository action request must be an object.");
    if (kind !== "map_workspace") this.adapters.require(adapter_id);
    const request_digest = digest(request);
    let action;
    let existingResult;
    await this.store.change((data) => {
      ensureProvisioningState(data);
      const existing = Object.values(data.repository_actions).find((candidate) => candidate.idempotency_key === idempotency_key);
      if (existing) {
        if (existing.kind !== kind || existing.request_digest !== request_digest || existing.adapter_id !== adapter_id) {
          throw new Error("Repository action idempotency key already exists with different input.");
        }
        if (existing.status === "succeeded") existingResult = actionResult(existing, data);
        else if (["pending", "reconciliation_required"].includes(existing.status)) {
          throw new Error(`Repository action ${existing.id} requires reconciliation before retry.`);
        } else throw new Error(`Repository action ${existing.id} previously failed; use a new idempotency key after inspection.`);
        return;
      }
      if (repository_id && !data.repositories[repository_id]) throw new Error(`Unknown repository: ${repository_id}`);
      const now = this.now();
      action = {
        id: this.id(), kind, status: "pending", adapter_id, repository_id, idempotency_key, request_digest,
        request: clone(request), actor, node_id: this.store.node?.id ?? null, node_name: this.store.node?.name ?? null,
        started_at: now, finished_at: null, attempt: 1, evidence: [], error: null,
      };
      data.repository_actions[action.id] = action;
      if (["create", "connect"].includes(kind) && repository_id) data.repositories[repository_id].lifecycle_state = "provisioning";
    });
    if (existingResult) return existingResult;

    try {
      const response = await invoke(kind === "map_workspace" ? null : this.adapters.require(adapter_id));
      await this.store.change((data) => {
        ensureProvisioningState(data);
        const current = data.repository_actions[action.id];
        const now = this.now();
        if (kind === "map_workspace") {
          const mappingId = this.id();
          const prior = Object.values(data.workspace_mappings).find((mapping) => mapping.repository_id === repository_id &&
            mapping.project_id === request.project_id && mapping.purpose === request.purpose && mapping.status === "active");
          if (prior) {
            prior.status = "superseded";
            prior.updated_at = now;
          }
          data.workspace_mappings[mappingId] = { id: mappingId, repository_id, project_id: request.project_id,
            workspace: response.workspace, purpose: request.purpose, status: "active", created_at: now, updated_at: now };
          current.result = { workspace_mapping_id: mappingId, workspace: response.workspace };
        } else {
          const inspected = response?.identity ?? response;
          const identity = repositoryIdentity({ ...inspected, adapter_id });
          const duplicate = Object.values(data.repositories).find((candidate) => candidate.id !== repository_id &&
            candidate.identity.adapter_id === identity.adapter_id && candidate.identity.provider_repository_id === identity.provider_repository_id);
          if (duplicate) throw new Error(`Repository is already connected: ${duplicate.id}`);
          const repoId = repository_id ?? this.id();
          const prior = data.repositories[repoId];
          const inspection = response?.inspection ?? {};
          const lifecycle = response?.lifecycle_state ?? (kind === "inspect" ? (inspection.ready === false ? "connected" : "ready") : "connected");
          if (!lifecycleStates.has(lifecycle)) throw new Error(`Invalid repository lifecycle state: ${lifecycle}`);
          data.repositories[repoId] = {
            id: repoId, identity, lifecycle_state: lifecycle, revision: (prior?.revision ?? 0) + 1,
            created_at: prior?.created_at ?? now, updated_at: now,
            last_inspected_at: kind === "inspect" ? now : prior?.last_inspected_at ?? null,
            inspection: kind === "inspect" ? clone(inspection) : prior?.inspection ?? null,
          };
          current.repository_id = repoId;
          current.result = { identity, lifecycle_state: lifecycle, inspection: clone(inspection) };
        }
        current.status = "succeeded";
        current.finished_at = now;
        current.evidence.push({ at: now, phase: "provider_result", result_digest: digest(current.result) });
      });
    } catch (error) {
      await this.store.change((data) => {
        ensureProvisioningState(data);
        const current = data.repository_actions[action.id];
        const now = this.now();
        current.status = kind === "inspect" || kind === "map_workspace" ? "failed" : "reconciliation_required";
        current.error = { name: error.name ?? "Error", message: error.message ?? String(error) };
        current.finished_at = now;
        current.evidence.push({ at: now, phase: "provider_error", error: clone(current.error) });
        if (current.repository_id && data.repositories[current.repository_id]) {
          data.repositories[current.repository_id].lifecycle_state = kind === "inspect" ? "disconnected" : "reconciliation_required";
          data.repositories[current.repository_id].updated_at = now;
        }
      });
      throw error;
    }
    const data = ensureProvisioningState(await this.store.read());
    return actionResult(data.repository_actions[action.id], data);
  }
}
