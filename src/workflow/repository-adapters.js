import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { digest } from "../storage/repository.js";
import { runProcess } from "./runtime.js";

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

const evidenceLimit = 2_000;

function bounded(value, limit = evidenceLimit) {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function errorRecord(error) {
  const result = { name: bounded(error?.name || "Error", 100), message: bounded(error?.message || error) };
  if (error?.evidence && typeof error.evidence === "object" && !Array.isArray(error.evidence)) {
    result.evidence = Object.fromEntries(Object.entries(error.evidence).slice(0, 12)
      .map(([key, value]) => [bounded(key, 80), bounded(value, 500)]));
  }
  return result;
}

function assertNoCredentials(value, location = "request") {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:token|password|secret|credential|authorization)/i.test(key)) {
      throw new Error(`Repository ${location} must not contain credentials; supply them through the execution environment.`);
    }
    if (entry && typeof entry === "object") assertNoCredentials(entry, `${location}.${key}`);
  }
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
    assertNoCredentials(request);
    return this.#perform({ kind: "create", adapter_id, request, idempotency_key, actor, invoke: (adapter) => adapter.create(clone(request)) });
  }

  async connect({ adapter_id, request, idempotency_key, actor = null }) {
    assertNoCredentials(request);
    return this.#perform({ kind: "connect", adapter_id, request, idempotency_key, actor, invoke: (adapter) => adapter.connect(clone(request)) });
  }

  async inspect({ repository_id, idempotency_key, actor = null }) {
    const snapshot = ensureProvisioningState(await this.store.read());
    const repository = snapshot.repositories[repository_id];
    if (!repository) throw new Error(`Unknown repository: ${repository_id}`);
    return this.#perform({ kind: "inspect", adapter_id: repository.identity.adapter_id,
      request: { repository_id, identity: repository.identity }, repository_id, idempotency_key, actor,
      invoke: (adapter) => adapter.inspect(clone(repository.identity), { previous_inspection: clone(repository.inspection) }) });
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
          const hasInspection = response && Object.hasOwn(response, "inspection");
          data.repositories[repoId] = {
            id: repoId, identity, lifecycle_state: lifecycle, revision: (prior?.revision ?? 0) + 1,
            created_at: prior?.created_at ?? now, updated_at: now,
            last_inspected_at: kind === "inspect" || hasInspection ? now : prior?.last_inspected_at ?? null,
            inspection: hasInspection ? clone(inspection) : prior?.inspection ?? null,
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
        current.error = errorRecord(error);
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

class RepositoryProviderError extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = "RepositoryProviderError";
    this.evidence = evidence;
  }
}

function repositoryName(value, field = "name") {
  const name = requiredString(value, field);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`${field} must be a valid repository name.`);
  }
  return name;
}

function branchName(value = "main") {
  const branch = requiredString(value, "initial_branch");
  if (branch.startsWith("-") || branch.includes("..") || /[\s~^:?*[\\]/.test(branch) || branch.endsWith(".") || branch.endsWith("/")) {
    throw new Error("initial_branch must be a valid Git branch name.");
  }
  return branch;
}

function githubRepository(value) {
  const supplied = requiredString(value, "repository");
  let candidate = supplied;
  try {
    const url = new URL(supplied);
    if (url.username || url.password) throw new Error("Repository URLs must not contain credentials.");
    if (url.hostname.toLowerCase() !== "github.com") throw new Error("Existing repositories must be hosted on github.com.");
    candidate = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch (error) {
    if (supplied.includes("://")) throw error;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) {
    throw new Error("repository must be an owner/name or github.com repository URL.");
  }
  return candidate;
}

/**
 * Direct GitHub provider. Authentication is read at call time and is only
 * passed to GitHub/Git through process memory. It is never added to a remote
 * URL, Git configuration, an adapter result, or durable action evidence.
 */
export class GitHubRepositoryAdapter extends RepositoryAdapter {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, run = runProcess,
    apiBaseUrl = "https://api.github.com", timeout = 30_000 } = {}) {
    super({ id: "github" });
    if (typeof fetchImpl !== "function") throw new Error("GitHub repository adapter requires fetch.");
    this.env = env;
    this.fetch = fetchImpl;
    this.run = run;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.timeout = timeout;
  }

  async create(request) {
    assertNoCredentials(request);
    const name = repositoryName(request?.name);
    const owner = this.env.ROUNDHOUSE_GITHUB_OWNER?.trim();
    const endpoint = owner ? `/orgs/${encodeURIComponent(owner)}/repos` : "/user/repos";
    const repository = await this.#api("POST", endpoint, {
      name, private: true, description: request.description == null ? undefined : bounded(request.description, 500),
      auto_init: false,
    }, "create");
    if (repository.private !== true) {
      throw new RepositoryProviderError("GitHub did not confirm that the created repository is private.", {
        phase: "provider_response", operation: "create", external_repository_state: "created_confirmed",
        provider_repository_id: repository.id, repository: repository.full_name,
      });
    }
    try {
      return await this.#connectedResult(repository, request, { newRepository: true });
    } catch (error) {
      throw new RepositoryProviderError(error.message, {
        phase: "local_workspace", external_repository_state: "created_confirmed",
        provider_repository_id: repository.id, repository: repository.full_name,
      });
    }
  }

  async connect(request) {
    assertNoCredentials(request);
    const name = githubRepository(request?.repository);
    const repository = await this.#api("GET", `/repos/${name.split("/").map(encodeURIComponent).join("/")}`, null, "connect");
    try {
      return await this.#connectedResult(repository, request);
    } catch (error) {
      throw new RepositoryProviderError(error.message, {
        phase: "local_workspace", external_repository_state: "existing_confirmed",
        provider_repository_id: repository.id, repository: repository.full_name,
      });
    }
  }

  async inspect(identity, context = {}) {
    const providerId = requiredString(identity?.provider_repository_id, "provider_repository_id");
    const repository = await this.#api("GET", `/repositories/${encodeURIComponent(providerId)}`, null, "inspect");
    const workspace = context.previous_inspection?.workspace;
    const inspection = workspace
      ? await this.#inspectWorkspace(workspace, repository.clone_url)
      : { ready: true, remote: repository.clone_url, default_ref: repository.default_branch ?? "main", workspace: null };
    return { identity: this.#identity(repository), lifecycle_state: inspection.ready ? "ready" : "connected", inspection };
  }

  #token() {
    const token = this.env.GITHUB_TOKEN?.trim() || this.env.GH_TOKEN?.trim();
    if (!token) throw new RepositoryProviderError("GitHub credentials are not available in the execution environment.", {
      phase: "credentials", external_repository_state: "not_attempted",
    });
    return token;
  }

  async #api(method, pathname, body, phase) {
    const token = this.#token();
    let response;
    try {
      response = await this.fetch(`${this.apiBaseUrl}${pathname}`, {
        method, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "roundhouse" },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeout),
      });
    } catch (error) {
      throw new RepositoryProviderError(`GitHub ${phase} request did not return a response.`, {
        phase: "provider_request", operation: phase, external_repository_state: "unknown", cause: error?.name ?? "Error",
      });
    }
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) {
      throw new RepositoryProviderError(`GitHub ${phase} request failed with HTTP ${response.status}.`, {
        phase: "provider_response", operation: phase, status: response.status,
        request_id: response.headers?.get?.("x-github-request-id") ?? "", response: bounded(payload.message ?? text, 500),
        external_repository_state: "not_confirmed",
      });
    }
    for (const field of ["id", "full_name", "html_url", "clone_url"]) {
      if (payload[field] == null || payload[field] === "") throw new RepositoryProviderError(`GitHub ${phase} response omitted ${field}.`, {
        phase: "provider_response", operation: phase, status: response.status, external_repository_state: "unknown",
      });
    }
    return payload;
  }

  #identity(repository) {
    return { provider_repository_id: String(repository.id), canonical_url: repository.html_url, display_name: repository.full_name };
  }

  async #connectedResult(repository, request, { newRepository = false } = {}) {
    const inspection = await this.#prepareWorkspace({ workspace: request.workspace, remote: repository.clone_url,
      initialBranch: request.initial_branch ?? repository.default_branch ?? "main", newRepository });
    return { identity: this.#identity(repository), lifecycle_state: inspection.ready ? "ready" : "connected", inspection };
  }

  #gitEnvironment(remote) {
    const token = this.#token();
    const url = new URL(remote);
    return {
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${url.origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    };
  }

  async #git(workspace, args, { optional = false, remote = null } = {}) {
    const result = await this.run(["git", "-C", workspace, ...args], {
      cwd: workspace, timeout: this.timeout, env: remote ? this.#gitEnvironment(remote) : {},
    });
    if (!result.passed && !optional) {
      throw new Error(`Git ${args[0]} failed: ${bounded(result.stderr || result.stdout || `exit ${result.exit_code}`, 500)}`);
    }
    return result;
  }

  async #prepareWorkspace({ workspace, remote, initialBranch, newRepository }) {
    const absolute = path.resolve(requiredString(workspace, "workspace"));
    const branch = branchName(initialBranch);
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    const worktree = await this.#git(absolute, ["rev-parse", "--is-inside-work-tree"], { optional: true });
    if (!worktree.passed) await this.#git(absolute, ["init", `--initial-branch=${branch}`]);
    const existingRemote = await this.#git(absolute, ["remote", "get-url", "origin"], { optional: true });
    if (!existingRemote.passed) await this.#git(absolute, ["remote", "add", "origin", remote]);
    else if (existingRemote.stdout.trim() !== remote) throw new Error("Git remote origin already points to a different repository.");
    const head = await this.#git(absolute, ["rev-parse", "--verify", "HEAD"], { optional: true });
    if (!head.passed) {
      const remoteBranch = newRepository ? null : await this.#git(absolute,
        ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { optional: true, remote });
      if (remoteBranch?.passed) {
        await this.#git(absolute, ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], { remote });
        await this.#git(absolute, ["checkout", "-B", branch, `origin/${branch}`]);
      } else if (newRepository || remoteBranch.exit_code === 2) {
        await this.#git(absolute, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
      } else throw new Error(`Git ls-remote failed: ${bounded(remoteBranch.stderr || remoteBranch.stdout || `exit ${remoteBranch.exit_code}`, 500)}`);
    }
    return this.#inspectWorkspace(absolute, remote);
  }

  async #inspectWorkspace(workspace, expectedRemote) {
    const absolute = path.resolve(workspace);
    const inside = await this.#git(absolute, ["rev-parse", "--is-inside-work-tree"], { optional: true });
    if (!inside.passed) return { ready: false, workspace: absolute, reason: "not_a_git_worktree" };
    const remote = await this.#git(absolute, ["remote", "get-url", "origin"], { optional: true });
    const branch = await this.#git(absolute, ["branch", "--show-current"], { optional: true });
    const head = await this.#git(absolute, ["rev-parse", "--verify", "HEAD"], { optional: true });
    const status = await this.#git(absolute, ["status", "--porcelain"], { optional: true });
    const remoteUrl = remote.passed ? remote.stdout.trim() : null;
    const currentBranch = branch.passed ? branch.stdout.trim() : "";
    return { ready: remoteUrl === expectedRemote && Boolean(currentBranch) && status.passed,
      workspace: absolute, remote: remoteUrl,
      default_ref: currentBranch || null, head: head.passed ? head.stdout.trim() : null,
      clean: status.passed ? status.stdout.trim() === "" : null };
  }
}
