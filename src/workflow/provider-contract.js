export const providerCapabilities = Object.freeze(["decision", "conversation", "execution"]);

const contracts = Object.freeze({
  codex: Object.freeze({ capabilities: Object.freeze([...providerCapabilities]) }),
  claude: Object.freeze({ capabilities: Object.freeze([...providerCapabilities]) }),
  command: Object.freeze({ capabilities: Object.freeze(["decision", "execution"]) }),
});

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export function providerContract(kind) {
  return contracts[kind] ?? null;
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
