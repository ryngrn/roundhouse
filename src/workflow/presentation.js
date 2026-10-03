export const presentationLanguage = Object.freeze({
  depot: "Depot",
  ready: "Ready to depart",
  needs: "Needs a signal",
  active: "Chugging along…",
  blocked: "Held up",
  completed: "Reached the station",
});

export function displayState(state, { needsYou = false } = {}) {
  if (needsYou || ["Needs Clarification", "Review"].includes(state)) return presentationLanguage.needs;
  if (["Depot", "Imported Pending", "Decision"].includes(state)) return presentationLanguage.depot;
  if (state === "Ready") return presentationLanguage.ready;
  if (["Executing", "Verification", "Rework"].includes(state)) return presentationLanguage.active;
  if (state === "Blocked") return presentationLanguage.blocked;
  if (["Shipped", "Imported History", "Archived", "Reconciled"].includes(state)) return presentationLanguage.completed;
  return state;
}
