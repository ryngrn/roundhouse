export const presentationLanguage = Object.freeze({
  depot: "Depot",
  ready: "Ready to depart",
  waiting_time: "Waiting for departure time",
  waiting_condition: "Waiting for its signal",
  needs: "Needs a signal",
  active: "Chugging along…",
  blocked: "Held up",
  completed: "Reached the station",
});

export function displayState(state, { needsYou = false, waiting = false } = {}) {
  if (needsYou || ["Needs Clarification", "Review"].includes(state)) return presentationLanguage.needs;
  if (waiting === "time") return presentationLanguage.waiting_time;
  if (waiting) return presentationLanguage.waiting_condition;
  if (["Depot", "Imported Pending", "Decision"].includes(state)) return presentationLanguage.depot;
  if (state === "Ready") return presentationLanguage.ready;
  if (["Executing", "Verification", "Rework"].includes(state)) return presentationLanguage.active;
  if (state === "Blocked") return presentationLanguage.blocked;
  if (["Shipped", "Imported History", "Archived", "Reconciled"].includes(state)) return presentationLanguage.completed;
  return state;
}
