# Cloud-native decision attempts — rollout gate

## What changed

- PostgreSQL migration 007 adds a durable receipt per decision evaluation, with
  a single active receipt per item, opaque completion token, start revision,
  deadline, owner-node audit and final outcome.
- A worker uses its **short item lease** only to transition into Decision and
  insert the receipt. It releases that lease before invoking the AI provider.
- A model result can be finalized from another authorized PostgreSQL node, but
  the same database transaction must still validate the receipt token, active
  deadline, and original item revision. Stale or duplicate results are rejected.
- An interrupted/expired attempt is quarantined. Neither the scheduler nor the
  Unblocker may automatically replay it. Existing questions and approvals stay
  under their original policy and revision guards.
- This is additive: existing Aiven PostgreSQL, no new services, no extra polling
  interval, no permission changes, and no automatic schedule activation.

## Controlled rollout

**Default is OFF.** Set `ROUNDHOUSE_DURABLE_DECISIONS=1` on a deliberately
configured Node.js worker (or `decision.durable_attempts: true` in a test
configuration) only after end-to-end testing in a dedicated PostgreSQL test
database. The current Studio service must not switch to the new mode solely
because migration 007 was installed.

The added table is not a scheduler. Cloud-first independence also requires an
authenticated, separately hosted control-plane worker with compatible decision
providers and costs measured before activation. Do not claim Studio-offline
readiness from this migration alone.

### Release acceptance

1. Dedicated `TEST_DATABASE_URL` database tests confirm no claim held during
   the model call, cross-node completion once, stale-result rejection, and
   expired-attempt quarantine. Never point these tests at live authority: they
   drop the `roundhouse` schema inside the **dedicated test database**.
2. Full non-live suite passes; production migration applied without changes to
   existing items, approvals, jobs, or schedules.
3. Controlled opt-in rollout of one new benign decision confirms durable receipt
   and project-policy gates, with rollback achieved by removing the flag.
4. Hosted scheduler is separately deployed and Studio-offline intake/decision
   acceptance is demonstrated before retiring Studio control-plane duty.

## Operator investigation

If a receipt expires, inspect `roundhouse.decision_attempts` and the item's
`triage.interrupted` state, correlate the execution output and revision, and
use the guarded explicit retry only after concluding the prior attempt cannot
commit. Do not delete receipts or force-reset another worker's lease.
