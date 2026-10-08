# Relay health operations

Roundhouse treats the wake channel as a hint and PostgreSQL as the authority. A
wake never contains work and cannot bypass the normal command claim, revision,
approval, ownership, verification, or shipping paths. If wake delivery fails,
already queued local work continues and durable remote commands wait for the next
successful PostgreSQL reconciliation.

## Visible states

The Control Room and `/health` derive one state from persisted observations. Times
below are the shipped defaults.

| State | Meaning | Operator response |
| --- | --- | --- |
| **Connected** | A successful PostgreSQL sync is no more than 15 minutes old and a useful wake message is no more than 60 minutes old. | No action. |
| **Wake Verified** | PostgreSQL sync is fresh, no wake is fresh, and the independent channel probe succeeded within 6 hours. | The subscription endpoint is reachable, but useful messages are absent. Check the publisher and topic configuration if this persists. |
| **Heartbeat Only** | PostgreSQL sync is fresh, but neither a useful wake nor an independent verification is fresh. | Work is being recovered by reconciliation. Inspect the wake service and retry evidence; do not replay commands manually. |
| **Disconnected** | The last successful PostgreSQL sync is older than 15 minutes or absent. Wake evidence alone cannot make this healthy. | Restore relay database connectivity first. Local workflow processing remains independent; remote commands remain durable. |

The labels are evidence summaries, not network-interface states. An accepted HTTP
stream is not proof of delivery: only a useful message updates `last wake`. A
successful empty command claim updates `last sync`, because it proves the
authoritative relay was queried successfully.

## Cadence, retries, and query budget

- The worker reconciles PostgreSQL every 5 minutes and once at startup. A wake or
  local mutation can request an additional cycle. Each cycle claims at most 20
  commands; remaining commands stay queued for a later cycle.
- An idle reconciliation uses one command-claim query. At the default cadence that
  is 288 claim queries per 24 hours. Each command claimed in a cycle adds one query
  before the final empty claim. Wake-triggered and explicit cycles add the same
  cost.
- Relay health records a 24-hour query-accounting window with a default budget of
  500. `used / budget` is observability, not a circuit breaker: reaching it is
  shown as `exhausted`, but Roundhouse does not strand durable work merely to make
  the counter look healthy. Investigate wake storms or an unexpectedly busy
  command queue when usage approaches the budget.
- The independent wake-channel probe runs at startup and every 6 hours. It is an
  HTTP channel check, not a PostgreSQL command claim, so it does not consume the
  displayed claim-query budget.
- A failed independent probe retries up to 3 times. Retry delay uses equal jitter
  over bounded exponential ceilings starting at 30 seconds and capped at 30
  minutes; after exhaustion it returns to the 6-hour cadence.
- A failed streaming subscription reconnects with the same bounded equal-jitter
  strategy, starting at 1 second and capped at 30 seconds. At most one stream and
  one retry timer are active.

`last successful sync`, query usage, verification outcome, consecutive failures,
backoff delay, and next retry survive process restart. Restart therefore cannot
optimistically turn a stale relay green or reset its cost evidence.

## Persistent drift and safe reconciliation

Any non-Connected state that persists for 60 minutes raises
`persistent_relay_drift`. The alert clears only when both a useful wake and a
successful sync are fresh. `Wake Verified` can therefore carry an alert: endpoint
reachability is useful evidence, but it does not prove that publisher messages are
arriving.

The independent probe may repair a live subscription mismatch only after it
successfully verifies the exact operator-owned `ROUNDHOUSE_WAKE_SUBSCRIBE_URL`
loaded at startup. Reconciliation replaces the live subscription with that exact
configuration. It is a strict no-op when configuration is missing, invalid, uses
an unsupported protocol, contains URL user information, or the probe fails. Remote
commands and runtime messages can never nominate a replacement target. The check
runs independently and does not pause or cancel a normal worker cycle.

## Secret-handling boundary

Treat the subscription URL and topic as secrets. Keep them in the service
environment, not repository configuration, command payloads, logs, screenshots,
or support tickets. Persisted and public health projections allowlist only:

- timestamps and freshness booleans;
- `unknown`, `verified`, or `failed` verification state;
- structured failure categories such as `timeout`, `http_status`, and
  `connection_error`;
- `unknown`, `matched`, or `mismatched` configuration state plus a reconciliation
  boolean;
- bounded retry counters/delays and aggregate query usage.

Raw URLs, topics, credentials, transport errors, and response bodies are neither
stored in relay-health evidence nor returned by `/health` or dashboard APIs.

## Recovery checklist

1. Read the state, last wake, last sync, verification result, retry time, and query
   usage together. A state label by itself does not identify the failed boundary.
2. For **Wake Verified**, verify the publisher commits the remote command before
   publishing its opaque wake. Wait for the next message; do not insert duplicate
   commands.
3. For **Heartbeat Only**, check the structured failure and allow bounded retries.
   Confirm the configured endpoint externally without copying its topic into logs.
4. For configuration drift, allow automatic reconciliation only when the display
   says the channel was verified and reconciled. Otherwise correct the service
   environment and restart deliberately.
5. For **Disconnected**, restore PostgreSQL/TLS/service credentials and wait for a
   successful normal claim. Do not delete leases, local state, or durable remote
   commands.
6. After restart, expect the prior unhealthy evidence to remain until a real sync
   occurs. A restored wake causes the normal idempotent claim path to run; already
   finished commands are not executed again, and the state returns to Connected
   only after both observations are fresh.

Deterministic coverage in `test/relay-health.test.js` exercises healthy delivery,
heartbeat-only fallback, persistent drift, verified reconciliation, disconnection,
restart, and recovery. It also asserts one execution of durable work and exact
claim-query accounting across the lifecycle.
