# Autonomous workflow architecture

The executable entry point is `roundhouse depot`. Roundhouse is authoritative; the
former local `capture` and Notion prototypes are retired, with Notion available only
through the one-time archive importer.

| Boundary | Current implementation | Replacement contract |
| --- | --- | --- |
| Depot source | Hosted Roundhouse dashboard/API, CLI JSON/text, and ChatGPT MCP | Submit immutable normalized input with a stable key |
| Project/context store | Private YAML/JSON manifest plus local context files | Validated project policy and context snapshot |
| Decision provider | Structured Codex response or command JSON protocol | `decide({item, projects, directory, onStart})` returns validated decision |
| Agent-role composer | Role manifest plus bounded Markdown skills and project context | General or Designer execution context and required evidence |
| Durable workflow | Authoritative Mac Studio local repository, state machine, Engine | Own claims, transitions, dependencies, human gates and delivery intent |
| Hosted relay | Aiven dashboard projection and remote-command queue | Mirror canonical job records without becoming workflow authority |
| Triage control plane | Independent bounded worker pass with durable attempts/backoff | Release imported work safely, classify, reconcile exact identities, slice, question, block, or make Ready |
| Execution runtime | Capability-selected provider over local Codex, opt-in Herdr, project command, or registered command adapters | Providers declare stable IDs/capabilities; `execute({project, job, workspace, previous_failure, onStart, onRemoteStart})` returns operational result |
| Verification | Configured argv commands, sourced role evidence, plus unchanged-commit check | `verify({project, workspace, commit, onStart})` returns checks and commit evidence |
| Shipping provider | Git worktree/commit/push plus fixture or command deployment | `supports`, `lock`, `prepare`, `snapshot`, `unchanged`, `ship` |
| Human feedback | Batched browser decision sessions, CLI approval/clarification, durable questions, and MCP answers | Revision-bound atomic response set, durable audit record, exactly one readiness reevaluation |
| Status adapters | Hosted projection reads, local cached menu status, MCP status tools, and MCP Events webhooks | Project/item-scoped projection of durable outbox transitions |

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

The combined local server owns the JSON API, MCP endpoint, and event-driven bounded
triage and dispatch cycles. The hosted control room reads its job-level projection
from the Aiven relay; the local server does not ship a second browser application.
HTTP handlers contain no routing, approval, execution, or shipping policy. A long
execution does not starve triage. The loops call the same Engine used by the CLI, so
worker locks, item leases, durable backoff, and conservative recovery continue to
govern both paths.

MCP Events is an outbound status adapter, not a second workflow. Subscriptions,
verification records, delivery attempts, stable event IDs, and retry state share
the authoritative repository. The adapter scans committed outbox transitions
and never executor stdout. It defaults to Needs You, Blocked, and completed Shipped
outcomes; progress transitions require explicit subscription opt-in. A subscription
starts at the current outbox position, preventing historical replay on creation or
restart. Manual MCP status tools remain available when a client does not support
Events.

## Durable ownership

The workflow depends on a storage repository boundary. On the Mac Studio, the local
repository is authoritative and writes a fsynced, atomically renamed `state.json`
under filesystem locks. Aiven contains only the hosted dashboard projection and
remote commands; it is not an alternate workflow store and cannot advance jobs.

An optional generic PostgreSQL storage adapter remains for separately planned
multi-node deployments. It normalizes items/revisions, decisions,
questions/answers, jobs/dependencies/attempts, agent roles, execution and
verification evidence, shipping/deployment, transition audit, outbox/MCP delivery,
nodes, leases, and import provenance. It is not enabled by the installed Studio
service and is never selected implicitly from relay credentials.

PostgreSQL job claims use a transaction and `FOR UPDATE SKIP LOCKED`. The same
transaction reserves a global slot, project allowance, counted resources, and
exclusive repository/delivery keys on the job lease. One live lease owner is
recorded with acquisition, heartbeat, and expiry timestamps. Separate project
leases add defense in depth around Git and remote delivery across nodes. Revision
guards reject stale writes. The delivery intent and outbox commit before external
delivery, and expired ownership blocks uncertain work for reconciliation instead of
replaying it. Advisory locks serialize schema migration and compatibility snapshot
mutations without becoming the job scheduler.

Storage selection is explicit. A configured PostgreSQL authority must fail closed
when unavailable; it must never fall back to a stale local file. Conversely, relay
failure does not transfer workflow authority away from the Studio's local store.

One-time Notion Depot imports add immutable provenance, legacy metadata,
ordinary project assignments without execution configuration, and a durable cutover marker. `Imported History`
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
only while safety-critical work owns a lease. The installed LaunchAgent keeps the
local server alive; an HTTP wake stream and local mutations trigger worker cycles.

Dispatch decisions are durable evidence too. Each scheduler round records every
considered project candidate, its eligibility checks, weighted rank, allocation or
deferral, and the capability, capacity, project, counted-resource, dependency, and
lock facts used for that result. PostgreSQL workers replace preliminary reservation
facts with the assessment made inside the atomic claim transaction. The CLI, API,
and control room project these records after restart instead of interpreting logs.

## Extending execution

Execution providers are registered under `execution.providers` and selected only by
the union of project and slice capability requirements. A provider must support the
entire set; Roundhouse never guesses an order for composing partial providers. The
smallest matching capability set wins, with provider ID as a deterministic tie-break.
The selected provider and required capabilities are retained with execution evidence.
This generic contract covers research, connected-source actions, scheduling,
artifact persistence, and human-task handling without importing their provider APIs
or policy into the Engine. A command adapter receives the normalized work packet,
durable run identity, and input digest on stdin in the prepared workspace. Exit zero
means operational success; stdout may be empty or contain one JSON object with
provider-owned results. Repository-free runs require a structured result or
workspace artifact. Verification and delivery remain Roundhouse-owned boundaries.

For a new CLI executor, configure `executor.kind: command` with an argv array.
It receives JSON on stdin containing `work`, `project_context`, and
`previous_failure`, runs with the isolated worktree as cwd, and returns exit 0 on
completion. Roundhouse owns verification and shipping. This supports wrapping
another installed agent today without changing the engine. Commands must remain
foreground and return when their work is done.

`runtime: local` remains the default. `runtime: herdr` is an opt-in execution
adapter requiring both `herdr.machine` and `herdr.agent`; it deliberately drives
an existing operator-configured agent instead of guessing how to provision one.
`herdr.workspace_mode` defaults to `shared_worktree`. The alternate
`machine_local` mode requires an absolute `herdr.working_directory` on the remote
machine. It probes `herdr machine status <machine> --json`, then invokes
`herdr --machine <machine> agent prompt <agent> <prompt> --wait --timeout <ms>`.
Every argument is passed directly without a shell. Machine, agent, and returned
remote IDs/status are persisted as `remote_execution` attempt metadata before and
after the prompt. A failure is explicit and never falls back to local execution.

In `shared_worktree`, Herdr owns only live remote execution. Roundhouse still
prepares the worktree and owns local verification, reconciliation, commits, and
shipping, so the agent must access the same absolute path and content. In
`machine_local`, Roundhouse does not prepare, inspect, or verify a local worktree.
The remote agent works only in the configured directory, runs the configured
checks, commits the exact job branch, performs the configured `commit_only` or
`push_branch` delivery, and emits a nonce-correlated structured report. Roundhouse
records that report with `independently_verified: false`; missing, malformed, or
failed evidence blocks the job without replay. Machine/agent/directory/run identity
and delivery intent are durable before dispatch, and completion identity is stored
afterward. A local Herdr CLI PID identifies only the client process; interruption
remains Blocked until explicit operator reconciliation of the remote result.

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
`durable_output` embeds bounded artifact bodies, hashes, provider provenance, and a
versioned reference in authoritative state while also writing an inspection
manifest. It uses artifact versions in place of Git SHAs while retaining the same
intent-before-delivery, verification, completion, failure, and reconciliation
lifecycle. Structured results can represent sourced briefs, findings, plans,
records, and next-action requests without a commit or deployment.

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
