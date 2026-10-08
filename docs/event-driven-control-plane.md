# Event-driven control plane

PostgreSQL is Roundhouse's authoritative durable state. Remote commands, workflow
transitions, revision guards, leases, evidence, and MCP event delivery state are
committed there before any downstream action is considered complete.

Studio is the execution runtime. It opens one optional HTTP streaming subscription
configured by `ROUNDHOUSE_WAKE_SUBSCRIBE_URL` (for example an ntfy JSON topic).
A wake contains no command or work data: it is a disposable, non-authoritative
nudge to inspect PostgreSQL. Duplicate wakes coalesce into one check, and a wake
received during that check produces at most one immediate follow-up. A sustained
burst is retained by a one-shot delay instead of creating a busy loop. A closed or failed wake
subscription reconnects with bounded exponential backoff and jitter, with at most
one live subscription and one pending retry. Lost wakes are recovered by the startup
cycle, an authenticated dashboard overview read, or the five-minute PostgreSQL
reconciliation pass; the durable command remains safe to retry.

An independent six-hour channel check probes the operator-owned subscription
configuration without running a worker cycle. It retries failures three times with
bounded exponential jitter, then returns to the low-frequency cadence so a bad
channel cannot create a busy loop. After the configured channel is independently
verified, a mismatched live subscription is replaced with that exact startup
configuration. Missing, invalid, user-info-bearing, or otherwise unverified
configuration disables this reconciliation. Health evidence records only matched,
mismatched, and reconciled results; it never exposes the URL or topic value.

The worker checks the remote-command relay every five minutes as a bounded safety
net, independently of the wake subscription. Each check claims at most twenty
remote commands; any remainder stays durable for a later wake or heartbeat. It also runs at startup, after a local
mutation, or after a wake message. Browser status is read once on open
and on explicit refresh or foreground lifecycle events. The macOS menu polls only
local process health and an in-memory last-known snapshot; `/health` is process
liveness and never probes PostgreSQL. Explicit human reads and real state
transitions may query the authoritative store.

MCP event delivery drains after state-changing tool calls and worker cycles. A
failed delivery uses a one-shot timer for its known next retry time, not a recurring
database sweep.

Execution and decision leases still heartbeat while work is actively running.
Those safety-critical timers prove live ownership and are intentionally retained.
The relay reconciliation timer is distinct from ownership heartbeats and exists
only to recover durable commands when wake delivery is unavailable. Reconciliation
continues to call the normal bounded triage and dispatch paths, so a wake cannot
bypass revision-bound approval, configured routing, ownership, or verification.

The private dashboard publishes to `ROUNDHOUSE_WAKE_PUBLISH_URL` only after its
remote-command insert commits. Publishing uses an opaque payload and a short
timeout. Failure is reported but never rolls back or fails the durable command.
