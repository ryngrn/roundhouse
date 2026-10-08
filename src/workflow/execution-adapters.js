import { runProcess } from "./runtime.js";
import { assertNotRemoteDesktopCommanderCommand } from "./remote-desktop-policy.js";
import { providerCapabilityEvidence, providerIdentity } from "./provider-contract.js";

const providerId = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;

export function requiredExecutionCapabilities(project, job = null) {
  return [...new Set([...(project.required_capabilities ?? []), ...(job?.work?.required_capabilities ?? [])])];
}

export function selectExecutionProvider(providers, requiredCapabilities, { exclude = [] } = {}) {
  const required = new Set(requiredCapabilities);
  const excluded = new Set(exclude);
  return (providers ?? [])
    .filter((provider) => !excluded.has(provider.id))
    .filter((provider) => requiredCapabilities.every((capability) => provider.capabilities.includes(capability)))
    .sort((left, right) => {
      const leftExtra = left.capabilities.filter((capability) => !required.has(capability)).length;
      const rightExtra = right.capabilities.filter((capability) => !required.has(capability)).length;
      return leftExtra - rightExtra || left.id.localeCompare(right.id);
    })[0] ?? null;
}

export function executionProviderEvidence(providers, requiredCapabilities, options = {}) {
  const selected = selectExecutionProvider(providers, requiredCapabilities, options);
  const evidence = providerCapabilityEvidence(providers, requiredCapabilities, selected);
  const excluded = [...new Set(options.exclude ?? [])];
  if (excluded.length) evidence.fallback = { excluded_provider_ids: excluded };
  return evidence;
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
      execute: adapter.execute.bind(adapter),
    });
    return this;
  }

  select(requiredCapabilities) {
    return selectExecutionProvider([...this.adapters.values()], requiredCapabilities);
  }

  get(id, requiredCapabilities) {
    const adapter = this.adapters.get(id);
    if (!adapter || !requiredCapabilities.every((capability) => adapter.capabilities.includes(capability))) return null;
    return adapter;
  }

  require(requiredCapabilities) {
    const adapter = this.select(requiredCapabilities);
    if (adapter) return adapter;
    const required = requiredCapabilities.length ? requiredCapabilities.join(", ") : "(none)";
    throw new Error(`No execution provider supports the required capability combination: ${required}.`);
  }
}

class ProjectExecutionAdapter {
  constructor(configuration, runtime) {
    this.id = configuration.id;
    this.capabilities = configuration.capabilities;
    this.runtime = runtime;
  }

  execute(request) {
    return this.runtime.execute(request);
  }
}

class CommandExecutionAdapter {
  constructor(configuration) {
    assertNotRemoteDesktopCommanderCommand(configuration.command, `Execution provider ${configuration.id}`);
    this.id = configuration.id;
    this.capabilities = configuration.capabilities;
    this.command = configuration.command;
  }

  async execute({ project, job, workspace, previous_failure, onStart, run }) {
    const { agent_profile: agentProfile, ...boundedProjectContext } = job.project_context;
    const packet = {
      work: job.work,
      project_context: boundedProjectContext,
      previous_failure,
      provider: { id: this.id, capabilities: this.capabilities },
      run,
    };
    const result = await runProcess(this.command, {
      cwd: workspace,
      input: JSON.stringify(packet),
      timeout: project.timeout_ms,
      onStart,
    });
    let output = null;
    if (result.stdout.trim()) {
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
    const adapter = request.run?.provider_id
      ? this.registry.get(request.run.provider_id, required)
      : this.registry.require(required);
    if (!adapter) {
      const resolved = this.registry.select(required);
      throw new Error(`Execution provider cannot change within attempt ${request.run.attempt}: selected ${request.run.provider_id}, resolved ${resolved?.id ?? "none"}.`);
    }
    if (request.run) request.run.provider_id = adapter.id;
    await request.onProviderStart?.(providerIdentity(adapter));
    const result = await adapter.execute(request);
    return { ...result, provider: { id: adapter.id, capabilities: [...adapter.capabilities], required } };
  }
}
