// Keep ownership renewal independent of advisory worker-presence telemetry.
// A lost lease is fatal to the current attempt; a failed node heartbeat is not.
// Transient database transport errors may be retried, but never beyond the
// last confirmed lease lifetime or without PostgreSQL-fenced state writes.
function transientTransport(error) {
  return ["ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ECONNREFUSED",
    "08001", "08003", "08006", "57P01", "57P03", "53300"].includes(error?.code)
    || /timeout exceeded when trying to connect|connection terminated unexpectedly/i.test(error?.message ?? "");
}

export function startLeaseHeartbeat(store, leases, {
  intervalMs = Math.max(1000, Math.floor(store.leaseMs / 3)),
  schedule = setInterval,
  unschedule = clearInterval,
  now = Date.now,
} = {}) {
  const activeLeases = leases.filter(Boolean);
  let lastConfirmedAt = now();
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
    try {
      await renewal;
      lastConfirmedAt = now();
    } catch (error) {
      // Connection problems do not prove lost ownership. Try again while the
      // last confirmed lease can still be valid; a real loss always stops.
      if (!transientTransport(error) || now() - lastConfirmedAt >= store.leaseMs) failure ??= error;
    } finally { if (pendingRenewal === renewal) pendingRenewal = null; }
  }

  const timer = schedule(() => { void tick(); }, intervalMs);
  timer?.unref?.();
  return {
    tick,
    assertHealthy() {
      if (failure) throw failure;
      if (now() - lastConfirmedAt >= store.leaseMs) {
        throw new Error("Lease renewal not confirmed within its lifetime; reconcile before retry.");
      }
    },
    async stop() {
      stopped = true;
      unschedule(timer);
      if (pendingRenewal) await pendingRenewal.catch(() => {});
      this.assertHealthy();
    },
  };
}
