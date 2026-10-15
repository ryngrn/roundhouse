// Read-only capability discovery. Presence is advisory; job leases remain authoritative.
export function eligibleWorkers(nodes, required = [], { now = Date.now(), maxAgeMs = 90_000 } = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('maxAgeMs must be positive');
  return nodes.filter(node => {
    const heartbeat = Date.parse(node.last_heartbeat_at);
    return node.status === 'online' && Number.isFinite(heartbeat)
      && heartbeat <= now && now - heartbeat <= maxAgeMs
      && required.every(capability => node.capabilities?.includes(capability));
  }).sort((a, b) => a.id.localeCompare(b.id));
}
