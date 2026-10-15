// Keep ownership renewal independent of advisory worker-presence telemetry.
// A lost lease is fatal to the current attempt; a failed node heartbeat is not.
export function startLeaseHeartbeat(store, leases, {
  intervalMs = Math.max(1000, Math.floor(store.leaseMs / 3)),
  schedule = setInterval,
  unschedule = clearInterval,
} = {}) {
  const activeLeases = leases.filter(Boolean);
  let pendingRenewal = null;
  let pendingNodeStatus = null;
  let failure = null;
  let stopped = false;

  async function tick() {
    if (stopped || failure || pendingRenewal) return;
    const renewal = Promise.all(activeLeases.map((lease) => store.heartbeatLease(lease)));
    pendingRenewal = renewal;
    // Presence is useful for placement, but it does not grant ownership.
    // Never allow a slow status update to delay the next lease renewal.
    if (!pendingNodeStatus && typeof store.heartbeatNode === "function") {
      pendingNodeStatus = Promise.resolve()
        .then(() => store.heartbeatNode("online"))
        .catch(() => {}) // availability is checked separately
        .finally(() => { pendingNodeStatus = null; });
    }
    try { await renewal; }
    catch (error) { failure ??= error; }
    finally { if (pendingRenewal === renewal) pendingRenewal = null; }
  }

  const timer = schedule(() => { void tick(); }, intervalMs);
  timer?.unref?.();
  return {
    tick,
    assertHealthy() { if (failure) throw failure; },
    async stop() {
      stopped = true;
      unschedule(timer);
      if (pendingRenewal) await pendingRenewal.catch(() => {});
      if (failure) throw failure;
    },
  };
}
