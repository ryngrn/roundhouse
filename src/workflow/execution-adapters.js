import { runProcess } from "./runtime.js";
import { assertNotRemoteDesktopCommanderCommand } from "./remote-desktop-policy.js";
import { providerAdvertisement, providerCapabilityEvidence, providerIdentity } from "./provider-contract.js";

const providerId = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const riskRank = Object.freeze({ read_only: 0, consequential: 1, human_task: 2 });

export function executionRoutingRequirements(project, job = null) {
  const work = job?.work ?? {};
  return {
    risk: work.action_class ?? "read_only",
    confidence: job?.routing_requirements?.confidence ?? 1,
    context_bytes: job?.routing_requirements?.context_bytes ?? Buffer.byteLength(JSON.stringify(job?.project_context ?? {})),
    max_latency_ms: job?.routing_requirements?.max_latency_ms ?? project.timeout_ms ?? null,
  };
}

function routingProbe(provider, requiredCapabilities, requirements) {
  const tier = provider.tier ?? 1;
  const maxRisk = provider.max_risk ?? "human_task";
  const minConfidence = provider.min_confidence ?? 0;
  const contextWindow = provider.context_window ?? Number.MAX_SAFE_INTEGER;
  const latencyMs = provider.latency_ms ?? 0;
  const currentCapabilities = provider.current_capabilities ?? provider.capabilities;
  const capability = requiredCapabilities.filter((entry) => !currentCapabilities.includes(entry));
  const gaps = {
    availability: provider.available === false ? { available: false, reason: provider.unavailable_reason ?? null } : null,
    capability,
    risk: riskRank[requirements.risk] > riskRank[maxRisk] ? { required: requirements.risk, supported: maxRisk } : null,
    confidence: requirements.confidence < minConfidence ? { required: requirements.confidence, minimum: minConfidence }
      : provider.current_confidence != null && provider.current_confidence < minConfidence
        ? { advertised: provider.current_confidence, minimum: minConfidence } : null,
    context: requirements.context_bytes > contextWindow ? { required: requirements.context_bytes, limit: contextWindow } : null,
    latency: requirements.max_latency_ms != null && latencyMs > requirements.max_latency_ms
      ? { required_max_ms: requirements.max_latency_ms, provider_ms: latencyMs } : null,
  };
  return { provider_id: provider.id, tier, eligible: !gaps.availability && !capability.length && !gaps.risk && !gaps.confidence && !gaps.context && !gaps.latency, gaps };
}

export function requiredExecutionCapabilities(project, job = null) {
  return [...new Set([...(project.required_capabilities ?? []), ...(job?.work?.required_capabilities ?? [])])];
}

export function selectExecutionProvider(providers, requiredCapabilities, { exclude = [], requirements = null } = {}) {
  const required = new Set(requiredCapabilities);
  const excluded = new Set(exclude);
  const routing = requirements ?? { risk: "read_only", confidence: 1, context_bytes: 0, max_latency_ms: null };
  return (providers ?? [])
    .filter((provider) => !excluded.has(provider.id))
    .filter((provider) => routingProbe(provider, requiredCapabilities, routing).eligible)
    .sort((left, right) => {
      const leftExtra = left.capabilities.filter((capability) => !required.has(capability)).length;
      const rightExtra = right.capabilities.filter((capability) => !required.has(capability)).length;
      return (left.tier ?? 1) - (right.tier ?? 1) || leftExtra - rightExtra || left.id.localeCompare(right.id);
    })[0] ?? null;
}

export function executionProviderEvidence(providers, requiredCapabilities, options = {}) {
  const selected = selectExecutionProvider(providers, requiredCapabilities, options);
  const requirements = options.requirements ?? { risk: "read_only", confidence: 1, context_bytes: 0, max_latency_ms: null };
  const probes = (providers ?? []).map((provider) => routingProbe(provider, requiredCapabilities, requirements));
  const evidence = providerCapabilityEvidence(providers, requiredCapabilities, selected, {
    requirements, results: probes,
    selection: selected ? { provider_id: selected.id, tier: selected.tier ?? 1,
      escalated: probes.some((probe) => probe.tier < (selected.tier ?? 1) && !probe.eligible) } : null,
  });
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
      tier: adapter.tier ?? 1,
      max_risk: adapter.max_risk ?? "human_task",
      min_confidence: adapter.min_confidence ?? 0,
      context_window: adapter.context_window ?? Number.MAX_SAFE_INTEGER,
      latency_ms: adapter.latency_ms ?? 0,
      probe: typeof adapter.probe === "function" ? adapter.probe.bind(adapter) : async ({ requiredCapabilities = [] } = {}) =>
        providerAdvertisement({ available: true, capabilities: adapter.capabilities }, adapter, requiredCapabilities),
      execute: adapter.execute.bind(adapter),
    });
    return this;
  }

  select(requiredCapabilities, options = {}) {
    return selectExecutionProvider([...this.adapters.values()], requiredCapabilities, options);
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
    Object.assign(this, { tier: configuration.tier, max_risk: configuration.max_risk, min_confidence: configuration.min_confidence,
      context_window: configuration.context_window, latency_ms: configuration.latency_ms });
    this.runtime = runtime;
  }

  execute(request) {
    return this.runtime.execute(request);
  }
}

class CommandExecutionAdapter {
  constructor(configuration) {
    assertNotRemoteDesktopCommanderCommand(configuration.command, `Execution provider ${configuration.id}`);
    if (configuration.probe) assertNotRemoteDesktopCommanderCommand(configuration.probe, `Execution provider ${configuration.id} probe`);
    this.id = configuration.id;
    this.capabilities = configuration.capabilities;
    Object.assign(this, { tier: configuration.tier, max_risk: configuration.max_risk, min_confidence: configuration.min_confidence,
      context_window: configuration.context_window, latency_ms: configuration.latency_ms });
    this.command = configuration.command;
    this.probeCommand = configuration.probe;
  }

  async probe({ project, workspace, run, requiredCapabilities, requirements, onStart }) {
    if (!this.probeCommand) return providerAdvertisement({ available: true, capabilities: this.capabilities }, this, requiredCapabilities);
    const result = await runProcess(this.probeCommand, {
      cwd: workspace,
      input: JSON.stringify({ provider: providerIdentity(this), required_capabilities: requiredCapabilities, requirements, run }),
      timeout: Math.min(project.timeout_ms ?? 30_000, 30_000),
      onStart,
    });
    if (!result.passed) return providerAdvertisement({ available: false, capabilities: [], reason: result.error ?? `Probe exited ${result.exit_code}.` }, this, requiredCapabilities);
    let output;
    try { output = JSON.parse(result.stdout); }
    catch { throw new Error(`Execution provider ${this.id} probe returned invalid JSON.`); }
    return providerAdvertisement(output, this, requiredCapabilities);
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
    const requirements = executionRoutingRequirements(request.project, request.job);
    const adapter = request.run?.provider_id
      ? this.registry.get(request.run.provider_id, required)
      : this.registry.select(required, { requirements });
    if (!adapter && !request.run?.provider_id) throw new Error("No execution provider satisfies the required routing contract.");
    if (!adapter) {
      const resolved = this.registry.select(required);
      throw new Error(`Execution provider cannot change within attempt ${request.run.attempt}: selected ${request.run.provider_id}, resolved ${resolved?.id ?? "none"}.`);
    }
    if (request.run) request.run.provider_id = adapter.id;
    const advertisement = await adapter.probe({ ...request, requiredCapabilities: required, requirements });
    if (!advertisement.eligible) {
      const category = !advertisement.available ? "availability" : advertisement.missing.length ? "capability" : "confidence";
      return { passed: false, exit_code: null, error: advertisement.reason,
        provider_probe: advertisement,
        provider_failure: { category, code: category === "availability" ? "provider_unavailable"
          : category === "capability" ? "capability_unavailable" : "confidence_below_threshold",
          dependency: advertisement.missing.length ? advertisement.missing.join(", ") : adapter.id,
          message: advertisement.reason, safe_to_retry: true, action_status: "not_started" },
        provider: { id: adapter.id, capabilities: [...adapter.capabilities], required } };
    }
    await request.onProviderStart?.(providerIdentity(adapter));
    const result = await adapter.execute(request);
    const confidence = result?.output?.confidence ?? result?.confidence;
    if (result?.passed && confidence != null && (!Number.isFinite(confidence) || confidence < adapter.min_confidence)) {
      const message = Number.isFinite(confidence)
        ? `Provider confidence ${confidence} is below the configured threshold ${adapter.min_confidence}.`
        : "Provider returned an invalid confidence value.";
      return { ...result, passed: false, error: message, provider_probe: advertisement,
        provider_failure: { category: "confidence", code: "confidence_below_threshold", dependency: adapter.id,
          message, safe_to_retry: true, action_status: "completed_locally" },
        provider: { id: adapter.id, capabilities: [...adapter.capabilities], required } };
    }
    return { ...result, provider_probe: advertisement,
      provider: { id: adapter.id, capabilities: [...adapter.capabilities], required } };
  }
}
