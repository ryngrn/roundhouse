import { WorkerLoop } from "./worker.js";

// A bounded, host-neutral control-plane invocation. The caller supplies its
// authenticated PostgreSQL store and, optionally, policy/decision adapters.
// Nothing here runs project executors, verifies jobs, or ships changes.
export async function cloudControlPlaneTick({
  store, service = null, commandQueue = null,
  recordSchedules = false, recover = false,
  handleCommands = false, evaluateDecisions = false,
  maxDue = 10, maxCommands = 5,
} = {}) {
  if (!store?.shared || typeof store?.status !== "function") {
    throw new Error("Cloud control plane requires shared PostgreSQL authority; local fallback is forbidden.");
  }
  const status = await store.status();
  if (status.kind !== "postgresql" || !status.authoritative || !status.connected || status.read_only) {
    throw new Error("Cloud control plane requires connected, writable PostgreSQL authority.");
  }
  if (!Number.isInteger(maxDue) || maxDue < 1 || maxDue > 10) throw new Error("Due limit must be 1–10.");
  if (!Number.isInteger(maxCommands) || maxCommands < 1 || maxCommands > 10) throw new Error("Command limit must be 1–10.");
  if (handleCommands && (!service || !commandQueue)) throw new Error("Remote-command processing requires a guarded service and relay.");
  if (evaluateDecisions && !service?.engine) throw new Error("Cloud decision evaluation requires configured policy and decision provider.");

  const due = recordSchedules ? await store.recordDueSchedules({ limit: maxDue }) : [];
  const recovered = recover ? await store.recoverExpiredClaims() : 0;
  let commands = { remote_commands: 0 };
  let triage = { triaged: 0 };
  if (handleCommands || evaluateDecisions) {
    const worker = new WorkerLoop({ service, commandQueue: handleCommands ? commandQueue : null });
    if (handleCommands) commands = await worker.remoteCommandTick({ maxCommands });
    if (evaluateDecisions) triage = await worker.triageTick();
  }
  // Do not call runDispatch: machine-local work and shipping have independent
  // executor authority and cannot be implied by a cloud scheduler heartbeat.
  return { authority: "postgresql", schedules_due: due.length, recovered,
    remote_commands: commands.remote_commands ?? 0, triaged: triage.triaged ?? 0,
    ...(commands.remote_command_error ? { remote_command_error: commands.remote_command_error } : {}),
    ...(triage.error ? { triage_error: triage.error } : {}) };
}
