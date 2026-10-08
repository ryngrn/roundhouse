# Event-driven control plane

The Mac Studio's local Roundhouse store is authoritative. Workflow transitions,
revision guards, evidence, job identity, and MCP event delivery state are committed
there before any downstream action is considered complete. Aiven stores only the
hosted dashboard projection and queued remote commands.

Studio is the execution runtime. It opens one optional HTTP streaming subscription
configured by `ROUNDHOUSE_WAKE_SUBSCRIBE_URL` (for example an ntfy JSON topic).
A wake contains no command or work data: it is a disposable, non-authoritative
nudge to inspect the Aiven command queue and authoritative local state. Duplicate wakes coalesce, lost wakes are recovered by
the one startup cycle or an authenticated dashboard overview read, and the durable
command remains safe to retry.

Roundhouse does not poll Aiven by default. The worker runs once at startup,
after a local mutation, or after a wake message. Browser status is read once on open
and on explicit refresh or foreground lifecycle events. The macOS menu polls the
canonical job-level local snapshot. Explicit human reads and real state transitions
query the authoritative local store.

MCP event delivery drains after state-changing tool calls and worker cycles. A
failed delivery uses a one-shot timer for its known next retry time, not a recurring
database sweep.

Execution and decision leases still heartbeat while work is actively running.
Those safety-critical timers prove live ownership and are intentionally retained;
there are no idle lease or worker heartbeats used as a polling backstop.

The private dashboard publishes to `ROUNDHOUSE_WAKE_PUBLISH_URL` only after its
remote-command insert commits. Publishing uses an opaque payload and a short
timeout. Failure is reported but never rolls back or fails the durable command.
