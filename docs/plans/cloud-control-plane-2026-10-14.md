# Cloud-authoritative Roundhouse: independently shippable slices

## Constraints

- Existing Aiven PostgreSQL is the only authoritative workflow database. No local fallback, no automatic database migration, no new paid Aiven service or tier without explicit cost approval.
- Favor local executors; cloud control plane must continue intake, questions, scheduling and durable decisions when Studio is offline.
- Never replay uncertain attempts, bypass an approval, merge protected work without the user's authorization, or publish unapproved project content.
- Claims must be revision-fenced and durable. Expired execution leases enter reconciliation; they do not authorize replay.

## Slice 1 — Ownership and lease diagnosis (priority P0)

**Outcome:** Explain and fix recurring `Lease lost: item/56a24f78a7dcbf67d50e3440` without rerunning failed work.

- Capture sanitized lease owner/token expiry and live scheduler timing, and distinguish expired, stolen or overlapping leases.
- Add deterministic regression for a slow decision and a second claimant, ensuring a lost lease never commits results.
- Ship only a demonstrated fix and verify fresh triage runs without a recurring lease error.
- Do not clear or forcibly seize a live lease. Acceptance: no repeated error over consecutive passes and audit evidence remains intact.

## Slice 2 — Cloud authority and hosted command routing (P0)

**Outcome:** Every mutation uses PostgreSQL's guarded workflow; no Studio-local state can advance authoritative work.

- Extend fail-closed guard to every production entrypoint and document credentials/configuration boundaries.
- Route hosted intake and decision commands to an always-available cloud control-plane entrypoint, using existing idempotency keys and revision checks.
- Verify submissions and decisions while Studio service is stopped, without touching local state.

## Slice 3 — Durable low-cost scheduling (P1)

**Outcome:** Persist recurring schedule and due events in existing Aiven PostgreSQL; no constant dashboard polling.

- Add schema-backed schedule definitions, next-due timestamps, idempotent occurrence IDs and audit receipts.
- Wake a hosted control-plane worker with bounded periodic checks (initial interval 1–5 minutes) or an event; no per-second polling.
- Provide telemetry for queries, writes, storage growth and service usage; set budget alarms before any capacity increase.
- Acceptance: each due occurrence recorded at most once across concurrent schedulers/restarts.

## Slice 4 — Independent hosted control plane (P1)

**Outcome:** Node.js triage, approval handling, lease recovery and routing run without the Studio.

- Deploy an authenticated minimal hosted process separately from macOS LaunchAgents, using existing Aiven PostgreSQL and guarded Engine.
- Restrict hosted capabilities to safe control-plane operations; no implicit Git shipping or privileged local commands.
- Verify cold restart, lost connectivity, and competing scheduler lease fencing; capture cost baseline before enabling recurring schedules.

## Slice 5 — Worker availability and dispatch preference (P2)

**Outcome:** Prefer registered local workers, fallback only to eligible explicitly configured cloud executor capabilities.

- Use durable heartbeats, cost-aware capability matches and timeout/backoff; no permission or credential propagation by assumption.
- On disappearance of a worker with uncertain delivery, block for reconciliation rather than repeat.
- Acceptance: Studio outage leaves other eligible workers selectable and preserves approval gates.

## Slice 6 — Studio-offline acceptance and cutover (P2)

- Demonstrate Studio-down intake, decision/approval persistence, scheduling, dispatch to available worker, and accurate dashboard projection.
- Test concurrency, Aiven disconnect, lease expiry and revival; record IDs and timestamps for all outcomes.
- Compare projection to database, reconcile only exact durable identities through guarded methods, and retire obsolete local scheduling once verification is complete.
- Roll back hosted scheduler independently without restoring local decision authority.

## Current evidence (October 14, 2026)

- Commit `9e0e7940897c4c9bdb22e1ae69aad05d0f241cdf` protects the default Studio `state` path from accidental local CLI use after cloud cutover.
- Studio health reported PostgreSQL authoritative but control-plane activity remains inside the Studio service; `Lease lost: item/56a24f78a7dcbf67d50e3440` was reported.
- No independently hosted scheduler, cloud execution fallback or Studio-offline end-to-end acceptance verified.

## Ship discipline

Each slice needs a reviewable commit, targeted tests, live evidence, and explicit statement of scope and cost. Do not mark later slices complete because an earlier guard or PostgreSQL connection is working.

## Connection and heartbeat hardening (October 14 evening)

- The Mac Studio service log records a fatal Node.js unhandled `pg` idle-client
  `error` event after an unexpected disconnect. A pool-level error listener is
  required to preserve process liveness. Errors from active database queries
  must still fail closed; no local state fallback is permitted.
- The existing triage and execution timers coupled authoritative lease renewal
  with the best-effort node-presence heartbeat, and launched another renewal
  every interval even when the prior one remained unresolved.
- Patch `fix/postgres-heartbeat-liveness-20261014` separates telemetry from
  lease ownership, serializes each renewal batch, and keeps a lost lease fatal.
  It neither extends leases arbitrarily nor retries uncertain executions.
- Read-only Aiven sample: three database sessions, no recorded deadlocks or
  conflicts; this is not proof that remote networking is reliable over time.
- This slice is not complete until production restart/idle-disconnect
  observability and multiple real worker passes are confirmed. Independent
  cloud scheduling and Studio-offline acceptance remain subsequent slices.

## Slice 3A — Dormant PostgreSQL schedule ledger (October 14)

- Add a small normalized `schedules` registry with minimum 5-minute cadence,
  revision, next-due UTC timestamp, explicit `enabled=false` default, and only
  `control_plane_wake`/`health_check` kinds (never arbitrary executor commands).
- Add immutable occurrence identity `(schedule_id, scheduled_for)` and due
  receipts. A bounded `FOR UPDATE SKIP LOCKED` transaction records no more
  than 50 due occurrences and advances through missed intervals without a
  costly backlog or duplicate claim after a restart.
- Existing projects, jobs, decisions, database authority and deployment
  policies are unchanged. No schedule is activated by the migration, and
  this slice intentionally creates no polling loops, cron jobs or services.
- **Not a completed cloud scheduler:** later isolated slices must add guarded
  schedule activation, independent hosted worker, budget telemetry, and
  Studio-offline acceptance before any schedule is made live. A receipt means
  "became due," not "executed successfully."
