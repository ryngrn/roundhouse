export const providerCapabilities = Object.freeze(["decision", "conversation", "execution"]);
export const fallbackProviderFailureCategories = Object.freeze(["quota", "authentication", "availability"]);

const contracts = Object.freeze({
  codex: Object.freeze({ capabilities: Object.freeze([...providerCapabilities]) }),
  claude: Object.freeze({ capabilities: Object.freeze([...providerCapabilities]) }),
  command: Object.freeze({ capabilities: Object.freeze(["decision", "execution"]) }),
});

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export function providerContract(kind) {
  return contracts[kind] ?? null;
}

// Provider evidence is deliberately an allowlisted projection. Provider
// configuration may contain executable paths, arguments, tool policy, or future
// credentials; none of those belong in workflow state or status responses.
export function providerIdentity(provider, fallbackId = null) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return null;
  const contract = providerContract(provider.kind);
  return {
    id: provider.id ?? fallbackId ?? provider.kind ?? null,
    kind: provider.kind ?? null,
    capabilities: [...(provider.capabilities ?? contract?.capabilities ?? [])],
    ...(Number.isInteger(provider.tier) ? { tier: provider.tier } : {}),
  };
}

export function providerCapabilityEvidence(providers, requiredCapabilities, selected = null, routing = null) {
  const required = [...new Set(requiredCapabilities ?? [])];
  const configured = (providers ?? []).map((provider) => providerIdentity(provider)).filter(Boolean);
  const probes = configured.map((provider) => {
    const missing = required.filter((capability) => !provider.capabilities.includes(capability));
    return { provider_id: provider.id, required: [...required], missing, supported: missing.length === 0 };
  });
  const selectedIdentity = selected ? providerIdentity(selected) : null;
  return {
    configured,
    selected: selectedIdentity,
    invoked: null,
    capability_probe: { required, results: probes },
    ...(routing ? { routing } : {}),
  };
}

const normalizedFailureCategory = (value) => {
  const text = String(value ?? "").toLowerCase().replaceAll("-", "_");
  if (text.includes("quota") || text.includes("rate_limit") || text.includes("capacity")) return "quota";
  if (text.includes("auth") || text.includes("credential") || text.includes("permission")) return "authentication";
  if (text.includes("avail") || text.includes("outage") || text.includes("dependency")) return "availability";
  return null;
};

/**
 * Providers may report a pre-action operational failure as structured evidence.
 * Fallback is deliberately opt-in: a category alone is insufficient because an
 * unavailable connection can still have left an external action uncertain.
 */
export function providerFailureEvidence(value) {
  const candidates = [value?.provider_failure, value?.output?.provider_failure,
    value?.failure?.provider, value?.details?.provider_failure].filter(Boolean);
  const reported = candidates.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
  if (!reported) return null;
  const category = normalizedFailureCategory(reported.category ?? reported.kind ?? reported.code);
  if (!fallbackProviderFailureCategories.includes(category)) return null;
  const actionStatus = reported.action_status ?? reported.external_actions ?? reported.side_effects ?? null;
  const replaySafe = reported.safe_to_retry === true || reported.replay_safe === true
    || ["none", "not_started", "pre_action"].includes(actionStatus);
  return {
    category,
    code: reported.code ?? null,
    dependency: reported.dependency ?? reported.capability ?? null,
    message: reported.message ?? value?.error ?? null,
    action_status: actionStatus,
    fallback_eligible: replaySafe,
  };
}

export function externallyUncertain(value) {
  const reported = value?.provider_failure ?? value?.output?.provider_failure
    ?? value?.failure?.provider ?? value?.details?.provider_failure;
  const status = reported?.action_status ?? reported?.external_actions ?? reported?.side_effects
    ?? value?.action_status ?? value?.external_action_status;
  return ["uncertain", "unknown", "started", "possibly_completed"].includes(status)
    || reported?.safe_to_retry === false || reported?.replay_safe === false;
}

export function validateProviderSelection(provider, capability, label) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new Error(`${label} must be a provider object.`);
  if (!providerCapabilities.includes(capability)) throw new Error(`Unknown provider capability: ${capability}.`);
  const contract = providerContract(provider.kind);
  if (!contract) throw new Error(`${label} kind ${String(provider.kind)} is unsupported; expected codex, claude, or command.`);
  if (!contract.capabilities.includes(capability)) throw new Error(`${label} kind ${provider.kind} does not support the ${capability} capability.`);
  if (provider.capabilities !== undefined) {
    if (!Array.isArray(provider.capabilities) || provider.capabilities.length === 0 || provider.capabilities.some((entry) => !providerCapabilities.includes(entry))) {
      throw new Error(`${label}.capabilities must contain supported provider capabilities: ${providerCapabilities.join(", ")}.`);
    }
    if (new Set(provider.capabilities).size !== provider.capabilities.length) throw new Error(`${label}.capabilities must be unique.`);
    if (!provider.capabilities.includes(capability)) throw new Error(`${label}.capabilities must include ${capability}.`);
    for (const declared of provider.capabilities) {
      if (!contract.capabilities.includes(declared)) throw new Error(`${label} kind ${provider.kind} does not support the ${declared} capability.`);
    }
  }
  if (provider.fallback !== undefined) {
    throw new Error(`${label}.fallback is unsupported; Roundhouse does not switch providers implicitly. Configure one provider and let Roundhouse own retries and recovery.`);
  }
  if (provider.kind === "command") {
    if (!Array.isArray(provider.command) || provider.command.length === 0 || !provider.command.every(nonempty)) throw new Error(`${label} command provider requires an argv array.`);
  } else {
    if (provider.command !== undefined) throw new Error(`${label} kind ${provider.kind} cannot define command; use bin for its CLI executable.`);
    if (provider.bin !== undefined && !nonempty(provider.bin)) throw new Error(`${label} kind ${provider.kind} bin must be nonempty.`);
  }
  if (provider.allowed_tools !== undefined && provider.kind !== "claude") throw new Error(`${label}.allowed_tools is supported only by the claude provider.`);
  return provider;
}

export function assertProviderRuntime(provider, runtime, label) {
  if (!["local", "herdr"].includes(runtime)) throw new Error(`${label} runtime ${String(runtime)} is unsupported; expected local or herdr.`);
}
