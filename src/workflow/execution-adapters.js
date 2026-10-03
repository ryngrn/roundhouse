import { runProcess } from "./runtime.js";

const providerId = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;

export function requiredExecutionCapabilities(project, job = null) {
  return [...new Set([...(project.required_capabilities ?? []), ...(job?.work?.required_capabilities ?? [])])];
}

export function selectExecutionProvider(providers, requiredCapabilities, { repositoryAvailable = true } = {}) {
  const required = new Set(requiredCapabilities);
  return (providers ?? [])
    .filter((provider) => repositoryAvailable || (provider.repository_required ?? provider.kind === "project") !== true)
    .filter((provider) => requiredCapabilities.every((capability) => provider.capabilities.includes(capability)))
    .sort((left, right) => {
      const leftExtra = left.capabilities.filter((capability) => !required.has(capability)).length;
      const rightExtra = right.capabilities.filter((capability) => !required.has(capability)).length;
      return leftExtra - rightExtra || left.id.localeCompare(right.id);
    })[0] ?? null;
}

export class ExecutionAdapterRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    if (!adapter || !providerId.test(adapter.id ?? "")) throw new Error("Execution provider requires a stable lowercase id.");
    if (!Array.isArray(adapter.capabilities) || new Set(adapter.capabilities).size !== adapter.capabilities.length) {
      throw new Error(`Execution provider ${adapter.id} capabilities must be a unique array.`);
    }
    if (adapter.capabilities.some((capability) => typeof capability !== "string" || !providerId.test(capability))) {
      throw new Error(`Execution provider ${adapter.id} capabilities must be stable lowercase identifiers.`);
    }
    if (typeof adapter.execute !== "function") throw new Error(`Execution provider ${adapter.id} must implement execute().`);
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate execution provider: ${adapter.id}`);
    this.adapters.set(adapter.id, {
      id: adapter.id,
      capabilities: [...adapter.capabilities],
      repository_required: adapter.repository_required === true,
      execute: adapter.execute.bind(adapter),
    });
    return this;
  }

  select(requiredCapabilities, options) {
    return selectExecutionProvider([...this.adapters.values()], requiredCapabilities, options);
  }

  require(requiredCapabilities, options) {
    const adapter = this.select(requiredCapabilities, options);
    if (adapter) return adapter;
    const required = requiredCapabilities.length ? requiredCapabilities.join(", ") : "(none)";
    throw new Error(`No execution provider supports the required capability combination: ${required}.`);
  }
}

class ProjectExecutionAdapter {
  constructor(configuration, runtime) {
    this.id = configuration.id;
    this.capabilities = configuration.capabilities;
    this.repository_required = configuration.repository_required ?? true;
    this.runtime = runtime;
  }

  execute(request) {
    return this.runtime.execute(request);
  }
}

class CommandExecutionAdapter {
  constructor(configuration) {
    this.id = configuration.id;
    this.capabilities = configuration.capabilities;
    this.repository_required = configuration.repository_required ?? false;
    this.command = configuration.command;
  }

  async execute({ project, job, workspace, previous_failure, onStart }) {
    const { agent_profile: agentProfile, ...boundedProjectContext } = job.project_context;
    const packet = {
      work: job.work,
      project_context: boundedProjectContext,
      previous_failure,
      provider: { id: this.id, capabilities: this.capabilities },
    };
    const result = await runProcess(this.command, {
      cwd: workspace,
      input: JSON.stringify(packet),
      timeout: project.timeout_ms,
      onStart,
    });
    let output = null;
    if (result.passed && result.stdout.trim()) {
      try { output = JSON.parse(result.stdout); }
      catch { throw new Error(`Execution provider ${this.id} returned invalid JSON.`); }
      if (!output || typeof output !== "object" || Array.isArray(output)) {
        throw new Error(`Execution provider ${this.id} must return a JSON object.`);
      }
    }
    return { ...result, output };
  }
}

export class CapabilityRuntime {
  constructor(providerConfigurations, projectRuntime) {
    this.registry = new ExecutionAdapterRegistry(providerConfigurations.map((configuration) => configuration.kind === "project"
      ? new ProjectExecutionAdapter(configuration, projectRuntime)
      : new CommandExecutionAdapter(configuration)));
  }

  async execute(request) {
    const required = requiredExecutionCapabilities(request.project, request.job);
    const adapter = this.registry.require(required, { repositoryAvailable: Boolean(request.project.repository) });
    const result = await adapter.execute(request);
    return { ...result, provider: { id: adapter.id, capabilities: [...adapter.capabilities], required } };
  }
}
