export const transitions = {
  "Imported Pending": ["Depot"],
  "Imported History": [],
  Depot: ["Decision"],
  Decision: ["Depot", "Ready", "Needs Clarification", "Review", "Archived", "Reconciled"],
  "Needs Clarification": ["Decision"],
  Ready: ["Executing", "Review"],
  Executing: ["Verification", "Rework", "Review"],
  Verification: ["Shipped", "Rework", "Review"],
  Rework: ["Executing"],
  Review: ["Ready", "Decision", "Shipped"],
  Blocked: ["Decision"],
  Archived: [],
  Reconciled: [],
  Shipped: [],
};

export function transition(record, next, reason) {
  if (next !== "Blocked" && !transitions[record.state]?.includes(next)) {
    throw new Error(`Invalid transition ${record.state} -> ${next}`);
  }
  const event = { from: record.state, to: next, reason, at: new Date().toISOString() };
  record.state = next;
  record.revision += 1;
  record.updated_at = event.at;
  record.history.push(event);
  return event;
}

export function record(id, fields = {}) {
  return { id, state: "Depot", revision: 1, created_at: new Date().toISOString(), history: [], ...fields };
}
