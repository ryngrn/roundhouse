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
| Execution runtime | Capability-selected provider over local Codex, project command, or registered command adapters | Providers declare stable IDs/capabilities; `execute({project, job, workspace, previous_failure, onStart})` returns operational result |
| Verification | Configured argv commands, sourced role evidence, plus unchanged-commit check | `verify({project, workspace, commit, onStart})` returns checks and commit evidence |
| Shipping provider | Policy coordinator over repository adapters plus fixture or command deployment | Authorize only configured delivery of the exact verified candidate |
| Repository operations | Registered repository adapters plus durable repository/action/workspace records | Provision with `create`, `connect`, and `inspect`; execute with `lock`, `prepare`, `snapshot`, `unchanged`, and `push` |
| Human feedback | Batched browser decision sessions, CLI approval/clarification, durable questions, and MCP answers | Revision-bound atomic response set, durable audit record, exactly one readiness reevaluation |
| Status adapters | Explicit/lifecycle browser reads, local cached menu status, MCP status tools, and MCP Events webhooks | Project/item-scoped projection of durable outbox transitions |

The Engine imports no Notion SDK and contains no Codex command-line flags. Runtime state is distinct from product state: a process exiting
does not decide that work is Shipped or needs Review.

Repository provisioning authority remains distinct from execution and delivery
policy, while both use the same `RepositoryAdapter` boundary. An adapter can create,
connect, and inspect repositories; a delivery-capable adapter also owns routine
branch, isolated-worktree, candidate-commit, mapping validation, unchanged-version,
and push mechanics. The domain stores only its stable adapter ID and the provider's opaque repository ID. Hosted
provider concepts such as owners, installations, organizations, and API node IDs
remain private to the adapter. Roundhouse persists an idempotency key, request
digest, actor/node provenance, lifecycle result, inspection evidence, and local
project/workspace mapping. Mutating intent is committed before the provider call;
an uncertain create/connect is marked `reconciliation_required` and is not replayed
under the same key. Adapter methods do not grant shipping authority: `GitDelivery`
checks configured policy and passing exact-commit verification before it invokes
an adapter push, then records delivery only after the adapter confirms the remote
branch SHA. Executor output cannot select an adapter, authorize a push, or mark a
job Shipped. Adapter credentials are process-owned and must not be included in the
durable provisioning request.

The initial `github` adapter creates private repositories or connects repositories
identified by `owner/name` (or a normal GitHub URL). Requests provide a repository
name or identity, an absolute or relative local workspace, and optionally an initial
branch and description. `GITHUB_TOKEN` (or `GH_TOKEN`) supplies API and HTTPS Git
authentication; `ROUNDHOUSE_GITHUB_OWNER` selects an organization creation endpoint.
The token is passed only in request/process environment headers and is never written
to the remote URL, Git configuration, action, repository record, or evidence. The
adapter initializes Git, configures `origin`, establishes the initial branch, fetches
an existing branch when present, and makes subsequent inspection idempotent. It
refuses to replace a conflicting existing remote. Provider and Git failures retain
bounded phase/status/request-ID evidence; a create without a definitive provider
response records the external repository state as unknown and requires reconciliation.

Lifecycle-driven creation is an explicit domain operation layered on that adapter
boundary. Project configuration names the customer lifecycle stage, adapter, trigger
stages, and credential-free provider request. Speculative transitions persist no
repository create action. A transition to configured managed or purchased service
persists the customer transition and repository intent together before calling the
provider. Both promotion destinations use the same stable project key, so only one
dedicated repository can be requested. The successful repository/action IDs—or the
need for external reconciliation after an uncertain result—remain on the durable
project projection across restarts.

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
and event-driven bounded triage and dispatch cycles. HTTP handlers contain no routing,
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
nodes, leases, import provenance, and repository provisioning/actions/workspace
mappings. JSONB is limited to variable provider/domain
payloads on those records; there is no monolithic state blob.

PostgreSQL job claims use a transaction and `FOR UPDATE SKIP LOCKED`. The same
transaction reserves a global slot, project allowance, counted resources, and
exclusive repository/delivery keys on the job lease. One live lease owner is
recorded with acquisition, heartbeat, and expiry timestamps. Separate project
leases add defense in depth around Git and remote delivery across nodes. Revision
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
only while safety-critical work owns a lease. The installed LaunchAgent keeps the
local server alive; an HTTP wake stream and local mutations trigger worker cycles.

Dispatch decisions are durable evidence too. Each scheduler round records every
considered project queue head, its eligibility checks, weighted rank, allocation or
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
or policy into the Engine. A command adapter receives the normalized work packet on
stdin in the prepared workspace. Exit zero means operational success; stdout may be
empty or contain one JSON object with provider-owned result references. Verification
and delivery remain Roundhouse-owned boundaries.

For a new CLI executor, configure `executor.kind: command` with an argv array.
It receives JSON on stdin containing `work`, `project_context`, and
`previous_failure`, plus an explicit workspace-only authority record. It runs with
the isolated worktree as cwd and returns exit 0 on completion. The record denies
commit, push, deploy, and Shipped-state authority; Roundhouse owns those operations
regardless of executor output. This supports wrapping
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

The default `local-git` repository adapter owns worktree preparation, candidate
commits, local/remote mapping checks, optional branch push, and unchanged-version
checks. `GitDelivery` coordinates that adapter under project policy. For
`shipping: deploy`, it invokes a configured deployment provider only after
verification. The deterministic fixture
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
