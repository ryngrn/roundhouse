const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export function normalizeDepotIntake(input, adapter = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Depot intake must be an object.");
  const text = input.text ?? input.content;
  const source = input.source ?? adapter.source;
  const actor = input.actor ?? adapter.actor;
  if (!nonempty(text)) throw new Error("Depot intake requires nonempty content.");
  if (!nonempty(source)) throw new Error("Depot intake requires a source.");
  if (!nonempty(actor)) throw new Error("Depot intake requires an actor.");
  if (text.length > 100_000) throw new Error("Depot intake content exceeds 100,000 characters.");
  if (input.project_hint !== undefined && (!nonempty(input.project_hint) || input.project_hint.length > 500)) throw new Error("project_hint must be a nonempty string of at most 500 characters.");
  const normalized = structuredClone(input);
  delete normalized.content;
  return { ...normalized, schema_version: 1, text, source, actor };
}

export function submitToDepot(store, input, key, adapter) {
  return store.submit(normalizeDepotIntake(input, adapter), key);
}
