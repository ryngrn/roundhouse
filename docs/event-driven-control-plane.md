# Event-driven control plane

PostgreSQL is Roundhouse's authoritative durable state. Remote commands, workflow
transitions, revision guards, leases, evidence, and MCP event delivery state are
committed there before any downstream action is considered complete.

Studio is the execution runtime. It opens one optional HTTP streaming subscription
configured by `ROUNDHOUSE_WAKE_SUBSCRIBE_URL` (for example an ntfy JSON topic).
A wake contains no command or work data: it is a disposable, non-authoritative
nudge to inspect PostgreSQL. Duplicate wakes coalesce. A closed or failed wake
subscription reconnects with bounded exponential backoff and jitter, with at most
one live subscription and one pending retry. Lost wakes are recovered by the startup
cycle, an authenticated dashboard overview read, or the five-minute PostgreSQL
reconciliation pass; the durable command remains safe to retry.

The worker checks the remote-command relay every five minutes as a bounded safety
net, independently of the wake subscription. It also runs at startup, after a local
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
only to recover durable commands when wake delivery is unavailable.

The private dashboard publishes to `ROUNDHOUSE_WAKE_PUBLISH_URL` only after its
remote-command insert commits. Publishing uses an opaque payload and a short
timeout. Failure is reported but never rolls back or fails the durable command.
