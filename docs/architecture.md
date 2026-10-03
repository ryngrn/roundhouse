# Autonomous workflow architecture

The executable entry point is `roundhouse depot`. The earlier `capture` command
remains a lightweight intake prototype. Roundhouse is authoritative; the former
Notion prototype is available only through the one-time archive importer.

| Boundary | Current implementation | Replacement contract |
| --- | --- | --- |
| Depot source | Roundhouse browser/API, CLI JSON/text, and ChatGPT MCP | Submit immutable normalized input with a stable key |
| Project/context store | Private YAML/JSON manifest plus local context files | Validated project policy and context snapshot |
| Decision provider | Structured Codex response or command JSON protocol | `decide({item, projects, directory, onStart})` returns validated decision |
| Agent-role composer | Role manifest plus bounded Markdown skills and project context | General or Designer execution context and required evidence |
| Durable workflow | PostgreSQL repository (shared) or explicit local repository, state machine, Engine | Own claims, transitions, dependencies, human gates and delivery intent |
| Triage control plane | Independent bounded worker pass with durable attempts/backoff | Release imported work safely, classify, reconcile exact identities, slice, question, block, or make Ready |
| Execution runtime | Local subprocess, Codex or configured command | `execute({project, job, workspace, previous_failure, onStart})` returns operational result |
| Verification | Configured argv commands, sourced role evidence, plus unchanged-commit check | `verify({project, workspace, commit, onStart})` returns checks and commit evidence |
| Shipping provider | Git worktree/commit/push plus fixture or command deployment | `supports`, `lock`, `prepare`, `snapshot`, `unchanged`, `ship` |
| Human feedback | Batched browser decision sessions, CLI approval/clarification, durable questions, and MCP answers | Revision-bound atomic response set, durable audit record, exactly one readiness reevaluation |
| Status adapters | Browser polling, MCP status tools, and MCP Events webhooks | Project/item-scoped projection of durable outbox transitions |

The Engine imports no Notion SDK and contains no Codex command-line flags. Runtime state is distinct from product state: a process exiting
does not decide that work is Shipped or needs Review.

`RoundhouseService` is the reusable external-adapter boundary. It normalizes intake,
queries work/questions, and submits guarded human answers to the Engine. The MCP
server contains schemas and presentation text only; the browser JSON API and future
email or Slack adapters must call the same service instead of implementing
inference or clarification state.

The browser submits decision sessions through
`POST /api/items/:id/decision-session`. The payload contains the item revision and
every open question in authoritative order with its question revision. Validation,
answer persistence, clarification audit records, and the transition back to
decision work share one repository transaction. A stale item or question returns
a structured conflict and zero answers are applied. The legacy MCP
`answer_question` tool remains available for external single-question clients.

The combined local server owns the browser control room, JSON API, MCP endpoint,
and independent bounded triage and dispatch loops. HTTP handlers contain no routing,
approval, execution, or shipping policy. A long execution does not starve triage.
The loops call the same Engine used by the CLI, so worker locks, item leases, durable
backoff, and conservative recovery continue to govern both paths.

MCP Events is an outbound status adapter, not a second workflow. Subscriptions,
verification records, delivery attempts, stable event IDs, and retry state share
the authoritative repository. The adapter scans committed outbox transitions
and never executor stdout. It defaults to Needs You, Blocked, and completed Shipped
outcomes; progress transitions require explicit subscription opt-in. A subscription
starts at the current outbox position, preventing historical replay on creation or
restart. Manual MCP status tools remain available when a client does not support
Events.

## Durable ownership

The workflow depends on a storage repository, not a JSON file. PostgreSQL is the
authoritative multi-node implementation. It normalizes items/revisions, decisions,
questions/answers, jobs/dependencies/attempts, agent roles, execution and
verification evidence, shipping/deployment, transition audit, outbox/MCP delivery,
nodes, leases, and import provenance. JSONB is limited to variable provider/domain
payloads on those records; there is no monolithic state blob.

PostgreSQL job claims use a transaction and `FOR UPDATE SKIP LOCKED`. One live lease
owner is recorded with acquisition, heartbeat, and expiry timestamps. Separate
project/resource leases protect Git and remote delivery across nodes. Revision
guards reject stale writes. The delivery intent and outbox commit before external
delivery, and expired ownership blocks uncertain work for reconciliation instead of
replaying it. Advisory locks serialize schema migration and compatibility snapshot
mutations without becoming the job scheduler.

The local repository writes a fsynced, atomically renamed `state.json` and uses
filesystem locks. It exists only for single-node development, tests, and bootstrap;
it is never a fallback when shared PostgreSQL is unavailable.

One-time Notion Depot imports add immutable provenance, legacy metadata,
non-executable project candidates, and a durable cutover marker. `Imported History`
is terminal. `Imported Pending` is eligible only for the triage control plane: triage
first commits a release into Depot with legacy status and provenance recorded as
non-authoritative evidence, then performs a normal native evaluation. It can never
be claimed directly by the execution scheduler.

Triage attempts, errors, exponential backoff, dependency fingerprints, import-release
evidence, decisions, and questions live on the durable item projection. Needs-a-signal
items are not re-polled until a human answer changes their revision. Held-up items are
not re-polled until a retry is requested or relevant project/config/dependency state
changes. Shared workers claim item leases before evaluation, while local triage uses a
separate filesystem lease from execution. Exact durable or provenance identities are
required for automatic reconciliation; prose similarity is never sufficient.

Claim intent, runtime process IDs, candidate commits, verification evidence, and
delivery intent are persisted at their boundaries. A restart never assumes an
interrupted external action did not happen. Recovery is conservative and retains
artifacts. PostgreSQL-backed nodes heartbeat their stable installation identities
and advertised capabilities. The installed LaunchAgent keeps the local server and
its polling worker alive.

## Extending execution

For a new CLI executor, configure `executor.kind: command` with an argv array.
It receives JSON on stdin containing `work`, `project_context`, and
`previous_failure`, runs with the isolated worktree as cwd, and returns exit 0 on
completion. Roundhouse owns verification and shipping. This supports wrapping
another installed agent today without changing the engine. Commands must remain
foreground and return when their work is done.

For Herdr/remote/cloud execution, implement the runtime interface and inject it
into Engine. Add runtime selection/validation to configuration. Return correlated
operational results and provide durable reconciliation for remote session IDs;
local PID recovery is insufficient for remote work. The current Git delivery
provider expects a local workspace, so a remote implementation must expose that
workspace locally or supply a corresponding remote delivery provider. These
adapters are extension boundaries, not claimed working integrations.

## Extending delivery

The Git delivery adapter owns worktree preparation, candidate commits, optional
branch push, and unchanged-version checks. For `shipping: deploy`, it invokes a
configured deployment provider only after verification. The deterministic fixture
provider has no external effect. The command provider receives a commit-bound JSON
packet and is the real integration path for an operator-owned deployment CLI.

Implement a provider that acquires resource ownership, prepares the target,
captures an immutable candidate identity, checks identity after verification, and
ships only passing evidence. Return repository/resource reference, branch/version,
commit/artifact identity, timestamp, verification and optional PR/deployment data.
Register other supported policies explicitly. A document provider can use artifact
versions in place of Git SHAs while retaining the same lifecycle. Non-code delivery
is not implemented by the current Git adapter.

## Configuration and audit trust

Project policy, role settings, context bounds, and verification commands are operator-owned configuration. Model
decisions cannot inject commands or select an unconfigured delivery policy. Input
and provider output are validated at the boundary. The model may still misjudge
semantic correctness; thresholds and tests are controls, not guarantees. State
files are private local data, not a tamper-proof audit system or multi-user auth
service. The `actor` field records the local operator's declared identity.

No hidden chain-of-thought is requested or persisted. Decision records contain only
the schema fields; raw Codex event streams are discarded. Command-provider output
and verification output are retained as configured operational evidence, so avoid
commands that print secrets.
