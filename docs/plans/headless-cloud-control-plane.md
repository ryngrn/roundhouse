# Headless cloud control plane — guarded deployment slice

## Scope

`node src/server/cloud-control-plane-cli.js` runs **one bounded invocation**
against authoritative PostgreSQL. It does not run the web server or dispatch
project executors. No cron, schedule, or service is enabled automatically.

Default invocation makes an authority health check only. Optional arguments:

- `--due`: record at most 10 due schedule occurrences (no job dispatch).
- `--recover`: invoke conservative PostgreSQL recovery for expired ownership;
  uncertain attempts become Blocked and require reconciliation, not replay.
- `--commands`: consume at most five remote relay commands through existing
  guarded RoundhouseService methods. Requires `ROUNDHOUSE_CLOUD_COMMANDS=1`
  and the approved `ROUNDHOUSE_CONFIG`.
- `--triage`: one bounded decision pass using the configured decision provider;
  requires `ROUNDHOUSE_DURABLE_DECISIONS=1`, `ROUNDHOUSE_CONFIG`,
  and compatible cloud-side provider credentials and binaries. **Never enable
  solely because the Studio is offline.** Test policy and identity first.

No invocation executes jobs, bypasses human gates, force-releases live leases,
changes permissions, merges Git branches, or publishes assets.

## Runtime requirements

- `DATABASE_URL` (or `ROUNDHOUSE_RELAY_DATABASE_URL`), with production-grade TLS.
- `ROUNDHOUSE_STATE_DIR` on a persistent, dedicated host filesystem for stable
  node identity. **Never reuse the Studio worker's state directory:** this
  runner advertises only the `decision` capability.
- If handling commands, `ROUNDHOUSE_RELAY_DATABASE_URL` and credentials
  for the same Aiven instance plus `ROUNDHOUSE_CONFIG`. Access controls and
  revision gates remain inside Roundhouse's existing domain service.
- If making decisions, the same approved project manifest as the cloud authority,
  a supported decision provider, and explicit feature-flag activation.

Suggested initial call on a dedicated host:

```sh
node src/server/cloud-control-plane-cli.js --health
```

For conservative scheduled maintenance after independent host setup:

```sh
node src/server/cloud-control-plane-cli.js --due --recover
```

Schedule externally no more frequently than five minutes initially, with
published usage measurements and a rate cap. No additional Aiven service,
`pg_cron` extension, or Netlify background function was created by this slice.

## Acceptance before switching away from Studio

1. A dedicated PostgreSQL test database passes concurrency, stale receipt,
   expired attempt, and review/approval-gate tests.
2. A separately hosted instance responds with the Studio physically offline.
3. Command and decision paths work from that host using the approved project
   manifest, while an ineligible worker cannot dispatch or ship.
4. Measure connection count, recurring database writes, and cloud provider
   costs. No new paid capacity without approval.
5. Only then retire local scheduling, leaving local execution as preferred.

This slice establishes the safe invocation surface; it **does not** establish
Studio-offline resilience until a remote host is actually configured, deployed,
and tested. Do not present the presence of a script as running cloud automation.
