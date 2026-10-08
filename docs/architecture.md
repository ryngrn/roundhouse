# Autonomous workflow architecture

The executable entry point is `roundhouse depot`. The earlier `capture` command
remains a lightweight intake prototype. Roundhouse is authoritative; the former
Notion prototype is available only through the one-time archive importer.

| Boundary | Current implementation | Replacement contract |
| --- | --- | --- |
| Depot source | Roundhouse browser/API, CLI JSON/text, and ChatGPT MCP | Submit immutable normalized input with a stable key |
| Project/context store | Private YAML/JSON manifest plus local context files | Validated project policy and context snapshot |
| Decision provider | Structured Codex or Claude Code response, or command JSON protocol | `decide({item, projects, directory, onStart})` returns validated decision |
| Conversation provider | Optional Codex or Claude provider contract without workflow authority or tools | Carry bounded human-facing interaction without deciding readiness or delivery |
| Agent-role composer | Role manifest plus bounded Markdown skills and project context | General or Designer execution context and required evidence |
| Durable workflow | PostgreSQL repository (shared) or explicit local repository, state machine, Engine | Own claims, transitions, dependencies, human gates and delivery intent |
| Scheduled eligibility | Persisted absolute timestamps, recurrence cursors, and condition signals | Explain waiting/due transitions and release each occurrence at most once |
| Triage control plane | Independent bounded worker pass with durable attempts/backoff | Release imported work safely, classify, reconcile exact identities, slice, question, block, or make Ready |
| Execution runtime | Capability-selected provider over local Codex, Claude Code, project command, or registered command adapters | Providers declare stable IDs/capabilities; `execute({project, job, workspace, previous_failure, onStart})` returns operational result |
| Execution-tool interface | Centrally supplied AXI preference with existing Git/GitHub CLI and Playwright/browser fallbacks | Let an executor choose an efficient supported tool without changing its runtime or authority |
| Verification | Configured argv commands, sourced role evidence, plus unchanged-commit check | `verify({project, workspace, commit, onStart})` returns checks and commit evidence |
| Shipping provider | Git worktree/commit/push plus fixture or command deployment | `supports`, `lock`, `prepare`, `snapshot`, `unchanged`, `ship` |
| Human feedback | Batched browser decision sessions, CLI approval/clarification, durable questions, and MCP answers | Revision-bound atomic response set, durable audit record, exactly one readiness reevaluation |
| Status adapters | Explicit/lifecycle browser reads, local cached menu status, MCP status tools, and MCP Events webhooks | Project/item-scoped projection of durable outbox transitions |

The Engine imports no Notion SDK and contains no Codex or Claude Code command-line flags. Runtime state is distinct from product state: a process exiting
does not decide that work is Shipped or needs Review.

## Control plane, runtime, and execution tools

Roundhouse is the control plane. It owns intake, policy, project and provider
selection, claims, approval gates, configured verification requirements, delivery
intent, lifecycle state, and reconciliation. The selected execution runtime owns
only the bounded implementation attempt. Local Codex, Claude Code, or a configured command is the
default software-project path; when work must run on a fleet machine, Herdr remains
the preferred runtime because it supplies the configured machine and agent boundary.

AXI sits one layer below that runtime. Model-agent prompts centrally prefer
`npx -y gh-axi` for supported GitHub operations and
`npx -y chrome-devtools-axi` for supported browser automation, inspection, and
verification. This shared prompt default applies to local Codex and both Herdr
workspace modes, so projects do not repeat AXI settings in their manifests. It does
not apply to arbitrary command providers, whose argv and behavior remain entirely
operator-owned.

An executor may use the existing Git or GitHub CLI path when GitHub AXI is absent,
cannot authenticate in that environment, or does not support the required
operation. It may use existing Playwright or browser tooling when browser AXI is
absent, cannot reach the target, or cannot perform the required inspection. This is
a tool-level fallback within the already selected runtime, not permission to switch
runtimes or providers. In particular, a Herdr probe, authentication, version, or
execution failure blocks for reconciliation; it never falls back to local work.
Herdr-backed Claude selection requires both machine reachability and a matching
agent advertisement with an installed version, valid authentication, usable quota,
and current availability before dispatch.

Tool choice does not change authority. AXI and fallback tools cannot approve work,
alter protected branches, authorize destructive actions, weaken or replace checks,
or infer permission to ship. In local and shared-worktree execution, Roundhouse
snapshots the result, runs configured verification, confirms the candidate is
unchanged, and performs the configured delivery. In machine-local Herdr execution,
the remote agent runs the exact configured checks and performs only the configured
`commit_only` or `push_branch` action; Roundhouse validates and records its
nonce-correlated attestation as not independently verified. Roundhouse remains the
authority for both paths and alone advances the durable job to Shipped.

Provider configuration uses the common `decision`, `conversation`, and `execution`
capability vocabulary. Existing `decision.kind` and project `executor.kind` settings
remain migration-compatible and retain their Codex defaults. Codex and Claude Code
may serve the three model-facing capabilities; command providers remain limited to
decision and execution boundaries. Provider fallback is deliberately unsupported:
failure remains attached to the selected attempt so Roundhouse can apply policy,
durable recovery, verification, and shipping without an implicit provider switch.

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
nodes, leases, and import provenance. JSONB is limited to variable provider/domain
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

Terminal execution outcomes use a separate, versioned contract. Its classifications
are `native_success`, `recovered_success`, `exception_success`, and
`failed_or_abandoned`; the record also retains the actual execution path, structured
reason, exception expectation, intervention count and optional minutes, and evidence
links. A native success is valid only with durable intake, dispatch, executor-owner,
verification, and delivery evidence. A Shipped state by itself is never sufficient.
Jobs without an outcome record are unclassified and excluded from outcome metrics,
as are jobs explicitly marked as historical imports.

The authoritative status read model exposes `execution_metrics` from those records.
Its `tasks_completed_without_intervention` denominator contains only measured,
completed outcomes, so neither a bare `Shipped` state nor imported history can raise
the KPI. The same projection reports classification counts, recovered-versus-bypassed
share, exception reasons, expected versus unexpected exceptions, intervention
averages and medians, daily trends, and exception rates by project,
executor/provider, machine/runtime, and job type. Every aggregate includes counts or
denominators alongside rates, and the drill-down retains the contributing job IDs
and evidence links.

Known isolated execution or verification exhaustion is held at job scope. The
scheduler may pass that branch for a later Ready job only when no dependency edge
connects them. Unknown remote outcomes, interrupted ownership, delivery uncertainty,
operator stops, and review gates remain project-wide dispatch gates. Both scopes and
their causes are durable status facts rather than inferred process activity.

Status reads also make a best-effort local observation of configured executor
processes and configured-repository worktrees. Observations are correlated with
the durable process-launch and prepared-worktree records. An unmatched observation
is projected separately as `untracked_activity`; it never becomes an active job and
does not imply a Roundhouse owner, lifecycle state, completion, verification, or
delivery. Platforms that cannot provide process or Git worktree inspection report
that limitation in `activity_inspection` while normal durable status and dispatch
continue unchanged.

Correlation deliberately recognizes only configured executor command prefixes and
prepared worktrees. A command that merely mentions an executor and the repository's
main worktree are excluded to limit false positives. Detection remains advisory:
PID reuse, wrappers, containers, remote hosts, and `machine_local` filesystems can
hide or confuse observations. Operators inspect the reported local resource and
durable provenance, preserve or stop unexpected work as appropriate, reconcile any
external effects, and route unfinished intent back through Depot intake. They do
not attach an observation to a job or infer delivery from it.

Time and external-condition waits are eligibility state on Ready jobs, independent
from the item/job lifecycle state. Absolute timestamps avoid timezone/default-clock
reinterpretation. Recurrence timestamps derive from a persisted anchor and ordinal,
and successor creation is atomic with confirmed delivery. Condition observations
are control-plane-owned, revisioned signals; they do not create questions, answers,
reviews, or failure blocks. PostgreSQL claims recheck persisted wait status and due
time transactionally before acquiring a job lease.

Dispatch decisions are durable evidence too. Each scheduler round records every
considered project queue head, its eligibility checks, weighted rank, allocation or
deferral, and the capability, capacity, project, counted-resource, dependency, and
lock facts used for that result. PostgreSQL workers replace preliminary reservation
facts with the assessment made inside the atomic claim transaction. The CLI, API,
and control room project these records after restart instead of interpreting logs.

## Extending execution

Action authority is a separate boundary from provider selection. Each normalized
slice is classified as `read_only`, `consequential`, or `human_task`; capability
semantics impose a trusted minimum classification. Consequential provider calls
require approval bound to the item revision, exact work digest, and project policy
digest, which is rechecked immediately before provider invocation. Human tasks are
never dispatched to an execution adapter. They use revision-guarded assignment and
evidenced completion records, and only explicit human completion can produce their
`human-task` shipping record.

Execution providers are registered under `execution.providers` and selected only by
the union of project and slice capability requirements. A provider must support the
entire set; Roundhouse never guesses an order for composing partial providers. Any
provider with a recorded capability, risk, confidence, context, or latency gap is
excluded before selection. The lowest configured cost tier wins; capability
specificity and provider ID are deterministic tie-breakers. Tier 0 supports
mechanical adapters without recursively asking a model to choose a model. The
selected provider, requirements, and probe gaps are retained with execution evidence.
This generic contract covers research, connected-source actions, scheduling,
artifact persistence, and human-task handling without importing their provider APIs
or policy into the Engine. A command adapter receives the normalized work packet,
durable run identity, and input digest on stdin in the prepared workspace. Exit zero
means operational success; stdout may be empty or contain one JSON object with
provider-owned results. Repository-free runs require a structured result or
workspace artifact. Verification and delivery remain Roundhouse-owned boundaries.
Command providers run in the foreground and must return when their slice completes;
future and conditional work belongs in the scheduling contract rather than provider
sleeps, polling loops, or detached processes. Provider stdout and workspace files
are untrusted outputs until the delivery adapter snapshots and verifies them.

For a new CLI executor, configure `executor.kind: command` with an argv array.
It receives JSON on stdin containing `work`, `project_context`, and
`previous_failure`, runs with the isolated worktree as cwd, and returns exit 0 on
completion. Roundhouse owns verification and shipping. This supports wrapping
another installed agent today without changing the engine. Commands must remain
foreground and return when their work is done.

`runtime: local` remains the default. Opt-in `runtime: herdr` requires either an
existing configured machine and agent or explicit placement bounds. Shared-worktree mode keeps local verification and
delivery ownership. `machine_local` instead requires an absolute remote working
directory and supports `commit_only` or `push_branch`: the remote agent runs the
configured checks, commits the exact job branch, performs the authorized delivery,
and emits a nonce-correlated report. Roundhouse persists the machine, agent,
directory, report token, remote run identity, evidence, and delivery intent. That
evidence is explicitly marked as not independently verified because the remote
filesystem is not locally visible. Herdr failures never fall back to local work.

Roundhouse owns placement requirements and the job lifecycle; Herdr may select a
machine, platform, and configured tool or agent only inside those requirements.
When `herdr.placement` is configured, Roundhouse invokes `herdr placement select
--json` before any machine probe or agent prompt. It sends a versioned JSON request
on stdin containing the job/run IDs and Roundhouse-owned requirements. Herdr returns
`eligible`, an optional `selection`, `rationale`, `source`, `observed_at`, and an
optional hold reason. Every advertised target explicitly names `runtime`, `machine`,
`platform`, `tool`, `agent`, `capabilities`, and `available`; Roundhouse rejects a
selection unless it is an available advertised target satisfying every bound.
Each Herdr attempt records the bounded requirements, eligible targets, selected
target, matched capabilities, rationale, source, and any capability/availability
hold before remote work begins. Request labels are not placement policy. Existing
static `herdr.machine` and `herdr.agent` projects are adapted to this evidence
contract and still require Herdr availability probes. A placement failure is
retained as a hold and never silently changes runtime, provider, tool, or agent.

Remote Desktop Commander is not an execution adapter or Herdr substitute. It is
reserved for transport, inspection, connectivity checks, bootstrap, and emergency
repair. Configuration validation rejects it at decision, execution-provider,
project-executor, verification, deployment, and Herdr command boundaries. Those
operational uses can restore or inspect the supported path, but cannot claim,
execute, verify, commit, push, or deliver project work outside Roundhouse.

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
