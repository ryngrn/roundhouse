import { deploymentProvider } from "./deployment.js";
import { LocalGitRepositoryAdapter, RepositoryAdapterRegistry } from "./repository-adapters.js";

export { git } from "./repository-adapters.js";

const defaultAdapterId = "local-git";

/**
 * Policy coordinator for repository delivery. All routine Git mechanics are
 * delegated to the selected RepositoryAdapter; this class alone decides when
 * a verified candidate is authorized to push or deploy.
 */
export class GitDelivery {
  constructor({ adapters } = {}) {
    this.adapters = adapters instanceof RepositoryAdapterRegistry
      ? adapters
      : new RepositoryAdapterRegistry(adapters ?? [new LocalGitRepositoryAdapter()]);
  }

  #adapter(project, prepared = null) {
    const configured = project.repository_adapter ?? defaultAdapterId;
    const selected = prepared?.adapter_id ?? configured;
    if (prepared && selected !== configured) throw new Error("Prepared workspace repository adapter no longer matches project configuration.");
    return this.adapters.requireDelivery(selected);
  }

  canDispatch(project) {
    try { return this.#adapter(project).canDispatch(project); }
    catch { return false; }
  }

  supports(projectOrPolicy) {
    if (typeof projectOrPolicy === "string") return ["commit_only", "push_branch"].includes(projectOrPolicy);
    const project = projectOrPolicy;
    let adapter;
    try { adapter = this.#adapter(project); } catch { return false; }
    if (!adapter.supportsDelivery(project)) return false;
    return ["commit_only", "push_branch"].includes(project.policy.shipping) ||
      (project.policy.shipping === "deploy" && Boolean(deploymentProvider(project)));
  }

  lock(project) {
    return this.#adapter(project).lock(project);
  }

  prepare({ project, job, directory, base }) {
    if (!this.supports(project)) throw new Error(`Shipping provider ${project.policy.shipping} is not installed.`);
    const push = project.policy.shipping === "push_branch" ||
      (project.policy.shipping === "deploy" && project.deployment.push_branch);
    return this.#adapter(project).prepare({ project, job, directory, base, push });
  }

  snapshot({ project, job, prepared }) {
    return this.#adapter(project, prepared).snapshot({ project, job, prepared });
  }

  unchanged(prepared, commit, project = null) {
    const effectiveProject = project ?? { repository_adapter: prepared.adapter_id };
    return this.#adapter(effectiveProject, prepared).unchanged(prepared, commit);
  }

  async ship({ project, prepared, verification, onStart }) {
    if (!verification.passed || !verification.checks.length || !verification.checks.every((check) => check.passed)) {
      throw new Error("Shipping requires passing verification evidence.");
    }
    const adapter = this.#adapter(project, prepared);
    if (!adapter.unchanged(prepared, verification.commit)) throw new Error("Tested version changed before shipping.");
    const result = {
      repository: project.repository, repository_adapter: adapter.id, branch: prepared.branch,
      commit: verification.commit, policy: project.policy.shipping, remote: prepared.remote,
      pr_url: null, deployment: null, verification, timestamp: new Date().toISOString(),
    };
    const push = project.policy.shipping === "push_branch" ||
      (project.policy.shipping === "deploy" && project.deployment.push_branch);
    if (push) Object.assign(result, await adapter.push({ project, prepared, commit: verification.commit, onStart }));
    else result.pushed = false;
    if (project.policy.shipping === "deploy") {
      const provider = deploymentProvider(project);
      result.deployment = await provider.deploy({ project, prepared, verification, onStart });
    }
    return result;
  }
}
