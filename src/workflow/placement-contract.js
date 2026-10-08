const identifier = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;

function uniqueIdentifiers(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !identifier.test(entry))
    || new Set(value).size !== value.length) {
    throw new Error(`${label} must contain unique stable lowercase identifiers.`);
  }
  return [...value];
}

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string.`);
  return value.trim();
}

function uniqueNames(value, label) {
  if (!Array.isArray(value) || !value.length || value.some((entry) => typeof entry !== "string" || !entry.trim())
    || new Set(value).size !== value.length) throw new Error(`${label} must contain unique nonempty strings.`);
  return value.map((entry) => entry.trim());
}

/**
 * Placement requirements are derived only from approved project/work policy.
 * Intake labels are deliberately not accepted by this boundary.
 */
export function herdrPlacementRequirements(project, job = null) {
  if (project.runtime !== "herdr") return null;
  const configured = project.herdr?.placement ?? {};
  const workCapabilities = job?.work?.required_capabilities ?? [];
  return {
    authority: "roundhouse",
    machine_selectors: configured.machine_selectors?.length
      ? uniqueNames(configured.machine_selectors, "Herdr placement machine_selectors")
      : [nonempty(project.herdr.machine, "Herdr machine selector")],
    platforms: uniqueIdentifiers(configured.platforms ?? ["herdr"], "Herdr placement platforms"),
    tools: uniqueIdentifiers(configured.tools ?? [project.executor.kind], "Herdr placement tools"),
    agents: configured.agents?.length
      ? uniqueNames(configured.agents, "Herdr placement agents")
      : [nonempty(project.herdr.agent, "Herdr agent")],
    capabilities: uniqueIdentifiers([...new Set([...(project.required_capabilities ?? []), ...workCapabilities,
      ...(configured.capabilities ?? [])])], "Herdr placement capabilities"),
    source: "roundhouse_project_policy",
  };
}

function target(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return {
    machine: nonempty(value.machine, `${label}.machine`),
    platform: nonempty(value.platform, `${label}.platform`),
    tool: nonempty(value.tool, `${label}.tool`),
    agent: nonempty(value.agent, `${label}.agent`),
    capabilities: uniqueIdentifiers(value.capabilities ?? [], `${label}.capabilities`),
    available: value.available !== false,
  };
}

export function herdrPlacementHold(requirements, eligible, reason = null) {
  const advertised = new Set(eligible.flatMap((entry) => entry.capabilities));
  const missing = requirements.capabilities.filter((capability) => !advertised.has(capability));
  return {
    code: missing.length ? "missing_capability" : "placement_unavailable",
    reason: reason ?? (missing.length
      ? `No eligible Herdr placement advertises: ${missing.join(", ")}.`
      : "No configured Herdr placement is currently available."),
    missing_capabilities: missing,
  };
}

/** Validate and bound Herdr's downstream placement result to Roundhouse policy. */
export function validateHerdrPlacement({ requirements, eligible = [], selection = null, rationale = null,
  source = "herdr", observed_at = new Date().toISOString() }) {
  if (!requirements || requirements.authority !== "roundhouse") throw new Error("Herdr placement requires Roundhouse-owned requirements.");
  const candidates = eligible.map((entry, index) => target(entry, `Herdr eligible placement ${index + 1}`));
  if (!selection) return {
    authority: { control_plane: "roundhouse", placement: "herdr" }, requirements, eligible: candidates,
    selection: null, hold: herdrPlacementHold(requirements, candidates), source, observed_at,
  };
  const selected = target(selection, "Herdr selected placement");
  const matching = candidates.find((entry) => entry.machine === selected.machine && entry.platform === selected.platform
    && entry.tool === selected.tool && entry.agent === selected.agent);
  if (!matching) throw new Error("Herdr selected placement must be one of the eligible advertised placements.");
  if (!matching.available) throw new Error("Herdr selected placement is not currently available.");
  if (selected.capabilities.length !== matching.capabilities.length
    || selected.capabilities.some((capability) => !matching.capabilities.includes(capability))) {
    throw new Error("Herdr selected placement capabilities must match its eligible advertisement.");
  }
  const policyMismatch = [
    requirements.machine_selectors.includes(selected.machine), requirements.platforms.includes(selected.platform),
    requirements.tools.includes(selected.tool), requirements.agents.includes(selected.agent),
  ].some((matches) => !matches);
  if (policyMismatch) throw new Error("Herdr selected placement is outside Roundhouse project policy.");
  const matchedCapabilities = requirements.capabilities.filter((capability) => matching.capabilities.includes(capability));
  if (matchedCapabilities.length !== requirements.capabilities.length) {
    throw new Error(`Herdr selected placement is missing required capabilities: ${requirements.capabilities
      .filter((capability) => !matchedCapabilities.includes(capability)).join(", ")}.`);
  }
  return {
    authority: { control_plane: "roundhouse", placement: "herdr" }, requirements, eligible: candidates,
    selection: { machine: selected.machine, platform: selected.platform, tool: selected.tool, agent: selected.agent,
      matched_capabilities: matchedCapabilities,
      rationale: nonempty(rationale, "Herdr placement rationale"), source: nonempty(source, "Herdr placement source") },
    hold: null, source, observed_at,
  };
}

/** Compatibility adapter for the original per-project machine/agent configuration. */
export function staticHerdrPlacement(project, job = null, { observed_at = new Date().toISOString() } = {}) {
  const requirements = herdrPlacementRequirements(project, job);
  const selected = {
    machine: project.herdr.machine,
    platform: project.herdr.placement?.platforms?.[0] ?? "herdr",
    tool: project.executor.kind,
    agent: project.herdr.agent,
    capabilities: requirements.capabilities,
  };
  return validateHerdrPlacement({ requirements, eligible: [selected], selection: selected,
    rationale: "Static project placement retained for compatibility; Herdr verifies availability before dispatch.",
    source: "static_project_config", observed_at });
}
