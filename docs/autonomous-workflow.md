# Depot to delivery

Depot holds incoming requests in their original wording. Submit an idea through
Roundhouse as text or JSON, then run the worker. The same workflow interprets
the request, creates executable work, verifies it, and delivers it. No manual
status movement is required for a successful autonomous job.

## Behavior

The control-plane lifecycle is Depot/Imported Pending → Decision → Ready, Needs
Clarification, Review, Blocked, Archived, or Reconciled. Imported Pending first gets a
durable, non-executable release into Depot; a legacy Ready/Running label is evidence,
not authority. The separate dispatch lifecycle is Ready → Executing → Verification →
Shipped. Low confidence or a material human decision leads to focused questions.
Execution or verification failure can enter bounded Rework; exhausted attempts,
infrastructure errors, or uncertain delivery lead to Blocked.

The service continuously runs triage with bounded concurrency, per-pass limits,
durable attempts, exponential backoff, item leases in shared mode, and weighted
priority that favors P0/P1 while preserving retry fairness. Triage continues while
execution capacity is full. Needs Clarification/Review is not re-polled until an
answer changes the item; Blocked is retried only after an explicit request or a
relevant dependency fingerprint changes. Use `roundhouse depot triage` for a
triage-only operator pass.

Review means a human decision is required. Successful execution does not itself
create Review. `review_after_shipping` can separately pause the project's queue
for human continuation approval while the delivered job remains Shipped.

Scheduled work remains `Ready` but carries a separate durable eligibility gate.
A time gate stores its absolute, timezone-qualified `eligible_at` timestamp; the
service installs only a one-shot wake for the earliest future timestamp and
reconstructs that wake from storage after restart. An external-condition gate names
a stable condition key and becomes eligible only after a durable signal is recorded through
`POST /api/conditions/:key/signal` or `depot signal-condition`. These waits are not
human questions and do not appear in Needs You; they are also not operational
failures and do not enter Blocked.

Recurring work uses an absolute anchor, a fixed interval in seconds, and a persisted
occurrence index, with optional occurrence/time bounds. The next timestamp is always
calculated from the anchor plus the index rather than the prior completion time.
Roundhouse creates the next occurrence in the same durable change that records the
previous occurrence as Shipped. Stable series/occurrence keys and a PostgreSQL
unique index prevent duplicate occurrence creation or dispatch after restart.

Each Depot item has a decision lifecycle and its initial decision may produce up to
eight sequential work jobs; a recurring job appends its bounded or ongoing
occurrences after successful delivery. Each job has its own execution lifecycle. The status command presents
the aggregate item state; all jobs must ship before the item displays Shipped.
The original request, clarifications, durable questions and answers, prior decisions,
project context, and job attempts remain on disk. Each question has a stable ID and
revision. Answering one records the response and immediately repeats decision and
readiness evaluation; execution remains separately owned by the worker.

The Codex or Claude Code decision provider returns structured JSON: likely project, project and
execution confidence, context sufficiency, safety/approval judgments, dependencies,
outcomes, executable acceptance criteria, runtime, executor, shipping policy, and
an optional stable `decision_key` for a clarification or review decision.
Confidence is a model judgment, not a statistical guarantee. Deterministic policy
enforces configurable thresholds, project matching, approval requirements, and
permitted runtime/delivery choices. Neither input text nor an imported legacy Ready flag can
override project policy. Only concise decision metadata is stored; Codex reasoning
traces are discarded, and sessions use ephemeral/no-persistence mode.

Provider selection has explicit decision, conversation, and execution capabilities.
Legacy Codex-only manifests and the existing `kind: claude` decision/executor shape
keep their defaults. An optional conversation provider is interaction-only and does
not receive execution tools or authority. Unsupported kinds, declared capabilities,
runtimes, Claude tool settings, and fallback combinations fail configuration with a
boundary-specific error. Roundhouse never changes providers implicitly after a
failure; its policy, durable claims, verification, recovery, and shipping authority
remain outside every provider.

Answered questions are sent back to later decision passes as `resolved_decisions`,
including the original prompt, answer, kind, and `decision_key`. Matching resolved
decisions are authoritative context. If a provider asks for the same resolved
decision again, Roundhouse blocks the item instead of opening another Needs You
question. This guard is deliberately domain-level state, not only prompt wording.

The decision agent writes acceptance criteria from the requested outcome and scope.
Roundhouse fills routine gaps with applicable configured checks, the shipping
destination, and the selected role's quality evidence. Experiential, scope, visual
review, and shipping criteria may intentionally have no command ID; that alone is
not a reason to ask a human. Unknown command IDs still fail readiness, and every
applicable configured command runs. Clarification is reserved for missing decisions
that could materially change the product outcome, scope, risk, authority, or an
irreversible action. Automated tests establish what they actually check, not
arbitrary product correctness; select meaningful project checks.

Repository requirements and execution capabilities are separate contracts. Existing
software projects remain repository-backed by default. A project can set
`repository_required: false` and omit `repository` and executable verification
commands; each generated slice then records its own `repository_required` value and
`required_capabilities`. Capability identifiers can describe research, integration,
scheduling, artifact production, external actions, human tasks, or installation-
specific facilities. Requirements do not need to be currently available in
`execution.capabilities`: unavailable requirements keep the slice unallocated and
produce durable, specific readiness and scheduler evidence. Repository-free projects
use `shipping: durable_output` (their default). That provider versions structured
results and workspace files, records hashes and provenance in authoritative state,
and writes a local inspection manifest. File bodies stay in the durable record so a
PostgreSQL reader does not depend on the originating worker filesystem. `artifact`
is accepted as a compatibility alias.

`execution.providers` registers replaceable execution adapters. Every provider has a
stable ID and declares the capability combinations it can handle. `kind: project`
uses the project's existing Codex or command executor; `kind: command` invokes the
provider's configured argv contract. Selection is provider-neutral and deterministic:
Roundhouse filters capability, risk, confidence, context, and latency gaps, then
picks the lowest configured cost tier. Capability specificity and provider ID are
stable tie-breakers. Tier 0 supports mechanical work without model-based routing.
Existing providers default to one neutral tier. Capabilities that exist only across
separate providers are not silently composed, so unsupported combinations remain Ready but unallocated with
durable `provider_unavailable` evidence. Research, connected-source work, scheduling,
artifact persistence, external actions, and human-task handling are ordinary
capability identifiers; the workflow contains no policy specific to any provider.
Repository-free command providers may return a summary and other JSON records and
may write artifact files in their workspace. At least one structured result or file
is required. Roundhouse records a run UUID, provider ID, input digest, attempt state,
failures, evidence, immutable output reference, and reconciliation state.

Remote Desktop Commander is never an execution provider. Its permitted scope is
transport, inspection, connectivity checks, bootstrap, and emergency repair of the
supported Roundhouse/Herdr path. Workflow configuration rejects it as a decision
provider, project executor, execution-provider command, verification command,
deployment command, or Herdr binary. It cannot claim, implement, verify, commit,
push, or deliver project work.

The supported ChatGPT path is `add_to_depot` → durable triage/readiness → an
authoritative Roundhouse claim → the configured local executor or Herdr runtime.
ChatGPT and Remote Desktop Commander do not own readiness, dispatch, verification,
or delivery. Best-effort local process and worktree observations appear separately
as untracked activity and never create or advance a job. An operator who sees one
should inspect the reported process/worktree, preserve evidence, stop unexpected
work when safe, reconcile possible side effects, and resubmit still-needed intent
through the Depot. Absence of a warning is not proof that no work exists: remote
machines and unavailable host inspection are outside this observation boundary.

### Repository-optional provider workflow

The deterministic Green Family Cemetery acceptance fixture is the concrete
repository-optional reference. Its project omits `repository`, sets
`repository_required: false`, has no executable verification commands, and uses
`shipping: durable_output`. The installation registers four command providers with
distinct capability contracts: `research` plus `connected-source`, `artifact`,
`scheduling`, and `external-action`. A slice is sent only to one provider that
supports its entire required capability set; Roundhouse does not merge partial
providers or infer a command from request text.

The fixture decision decomposes one intake into sequential research, cited-artifact,
future-follow-up, and scoped records-request proposal slices. Fixture source URIs
and fixed retrieval timestamps are provider results, not claims of live research.
Both those structured results and the Markdown file are captured by
`durable_output`; their bodies, hashes, provider/run identity, input digest, and
immutable output version survive store reconstruction. The local inspection
manifest is a convenience copy, not the authoritative record.

Scheduling is eligibility, not a background process. The follow-up uses an absolute
timezone-qualified `not_before` value and remains `Ready` but unclaimable until the
worker clock reaches it. A service restart reconstructs the same wait and next wake
from durable state. Recurrence derives later timestamps from its stored anchor and
ordinal; external-condition waits advance only through a revisioned control-plane
signal. Providers must not sleep, poll, or launch detached work for these waits.

`external-action` imposes a consequential classification even if Depot text or a
decision labels it read-only. Before any jobs are created, the fixture remains in
Review and no execution provider is invoked. Approval is bound to the current item
revision, exact slice digest, and project-policy digest, and that scope is checked
again immediately before provider execution. The fixture action provider only
returns a `proposed_not_sent` record and writes to its disposable fixture log: it
does not contact a records custodian, use a hosted source, deploy, push, or mutate a
real repository. A production provider may perform its configured external action
after approval, so its own idempotency and reconciliation contract remains required.

A corresponding project has this shape (provider commands are operator-owned argv
arrays and should use absolute executable/script paths):

```yaml
execution:
  capabilities: [research, connected-source, artifact, scheduling, external-action]
  providers:
    - id: cemetery-research
      kind: command
      capabilities: [research, connected-source]
      command: [/absolute/path/to/provider, research]
    - id: cemetery-artifact
      kind: command
      capabilities: [artifact]
      command: [/absolute/path/to/provider, artifact]
    - id: cemetery-scheduling
      kind: command
      capabilities: [scheduling]
      command: [/absolute/path/to/provider, scheduling]
    - id: cemetery-action
      kind: command
      capabilities: [external-action]
      command: [/absolute/path/to/provider, propose]
projects:
  - id: green-family-cemetery
    name: Green Family Cemetery
    purpose: Produce sourced cemetery research and bounded follow-up.
    success_state: Sourced outputs and approved next actions are durable.
    status: active
    repository_required: false
    verification: []
    policy:
      allow_autonomous: true
      approval_required: false
      shipping: durable_output
      continuation: continue_project_queue
```

`allow_autonomous` permits read-only slices; it does not waive the trusted
consequential-action gate. Keep credentials in the provider environment, keep
commands in private operator configuration, and avoid printing secrets because
provider output is retained as operational evidence.

## Agent roles and skills

Agent roles are context and skill bundles, separate from the executor and local
runtime. Roundhouse infers design-heavy briefs as `designer`; project config can
constrain `allowed_roles` or set a fixed `default_role`. Ordinary software work
continues through the general role.

Designer composes small Markdown skills under `src/agent/skills/` with optional
project-owned skill and context sources. Context is bounded by file count, per-file
bytes, and total bytes. Designer work records material design decisions and explicit
browser/visual evidence. Automated checks and agent visual review have distinct
evidence sources; Roundhouse does not treat an automated score as proof of beauty.

Model-agent execution guidance centrally prefers the low-token `npx -y gh-axi` interface
for supported GitHub operations and `npx -y chrome-devtools-axi` for supported
browser automation, inspection, and verification. The same preference is included
in local, shared-worktree Herdr, and machine-local Herdr prompts; it needs no
per-project manifest setting. Operator-owned command providers retain their exact
configured argv and do not inherit model tool preferences.

AXI is a tool interface beneath the selected executor, not a Roundhouse control
plane, execution runtime, verification provider, or shipping provider. Herdr remains
the preferred fleet runtime: it selects the operator-configured machine and agent,
while AXI may reduce tool traffic inside that agent's bounded attempt. Existing
Git/GitHub CLI tooling is the fallback when GitHub AXI is unavailable, cannot
authenticate, or does not support the required operation. Existing Playwright or
browser tooling is the fallback under the equivalent conditions for browser work.
These fallbacks do not permit a runtime or provider switch; a Herdr failure still
blocks and never falls back to local execution.

Neither AXI nor a fallback grants additional authority. They cannot approve work,
alter protected branches, authorize destructive operations or shipping, change
configured verification policy, or infer delivery intent. Roundhouse continues to
own claims, policy, verification requirements, delivery intent, and final lifecycle
transitions. Command boundaries remain argv-first; request content must never be
interpolated into shell source.

## Try it without credentials

From this repository:

```sh
npm install
npm test
npm run check
npm run acceptance
npm run demo
```

The demo creates a temporary project and bare Git remote, uses deterministic
decision/execution subprocesses, delivers two changes, checks their pushed SHAs,
and prints a product result with `passed: true`. It retains its temporary directory
and `demo-result.json` for inspection. It never contacts a hosted Git provider.
`npm run demo -- --live` exercises the same workflow using your authenticated
Codex CLI for both interpretation and execution. It may use model quota. Set
`ROUNDHOUSE_CODEX_BIN` if Codex is not on PATH.

For the live acceptance path that uses the real local Codex executor against a
disposable repository, run:

```sh
npm run acceptance:live
```

This command skips explicitly when the `codex` CLI is not installed or runnable.
It does not touch configured projects, real repositories, or real deployments.

## Run a real request

Copy `config/autonomy.example.yaml` into private configuration and set the project's
ID, repository, context files, and meaningful verification commands. Keep the
configuration and state directory outside the managed repository. Configure Git
identity and push authentication normally. The repository needs an existing commit,
a clean worktree, a pushable remote, and any dependencies necessary for its tests.
New worktrees do not inherit ignored files such as node_modules or .env; provision
dependencies through the executor or an appropriate project check. Secrets should
come from the execution environment, not Depot text or public configuration.

```sh
node src/cli.js depot submit --state-dir /absolute/path/to/roundhouse-state \
  --key request-001 --project example \
  --text "Describe the improvement you want in ordinary language."
node src/cli.js depot run --state-dir /absolute/path/to/roundhouse-state \
  --config /absolute/path/to/autonomy.yaml --project example
node src/cli.js depot status --state-dir /absolute/path/to/roundhouse-state
```

The stable submission key makes retries idempotent. Reusing a key with different
content is rejected. JSON input uses `text`, optional `project_id`, `source`, and
`actor`. Explicit project selection is checked against the decision. Without it,
the decision provider infers a project from the configured project context.

## Shipping and verification

The engine creates an isolated worktree on `codex/roundhouse-<job-id>`, executes the
work there, commits a candidate, and tests that exact commit. Changes made during
verification invalidate it. Failed candidates are retained locally but not shipped.
The local and shared-worktree execution runtimes are instructed not to push;
verification and delivery belong to Roundhouse. Their use of AXI or a fallback tool
does not change that ownership.

Projects default to `runtime: local`. An opt-in `runtime: herdr` project names an
existing machine and agent; Roundhouse probes that saved machine and never falls
back to local execution. A configured Claude executor also requires an advertised
remote Claude installation, version, authentication, quota, and current
availability before Roundhouse sends the bounded work. Each failed gate is
recorded separately and never triggers an implicit local or Codex fallback.
Shared-worktree mode preserves local verification and
delivery. In `machine_local` mode, `herdr.working_directory` is an absolute path on
the fleet machine and a local `repository` may be omitted. The remote agent runs
the configured checks, commits the executor-specific `claude/roundhouse-<job-id>`
or `codex/roundhouse-<job-id>` branch, and performs only the configured
`commit_only` or `push_branch` delivery. Its nonce-correlated report
must contain the full commit, exact branch, push result, summary, and one passing
record for every applicable verification ID. Roundhouse exposes the active machine,
agent, directory, and remote identity, then stores terminal evidence with
`independently_verified: false` because it cannot inspect the remote filesystem.
The remote agent performs that configured delivery because the filesystem is not
locally visible, but Roundhouse defines the permitted action, validates the report,
and alone records the authoritative Shipped transition.

Implemented delivery policies:

- `push_branch` (default): push the verified commit to its job branch and confirm
  that the remote reports the expected SHA. It does not merge or deploy.
- `commit_only`: retain the verified local branch and commit without pushing.
- `deploy`: optionally push the verified branch, then invoke either the
  deterministic no-op fixture provider or an operator-configured command provider.
  Only a successful provider result becomes Shipped.

`create_pull_request` and `merge_to_main` are recognized policy values
but block before execution until their provider is implemented. They never fall
back silently to another delivery mode. Git commit and push hooks are disabled for
engine-owned delivery; declare required checks explicitly in verification policy.

Delivery evidence includes repository, remote, branch, commit, verification command
arguments, output, exit codes, timestamps, and nullable PR/deployment fields.
Project commands are trusted executable configuration, not model-generated shell
strings. Local command executors are not a security sandbox; Codex uses its
workspace-write sandbox. Use trusted projects and commands.

Subsequent jobs for a project start from its last shipped commit, so queued changes
build on each other even when delivered to separate branches. There is no implicit
fetch or rebase; integrate upstream changes deliberately. Worktrees and failed
artifacts are retained for inspection, not automatically deleted.

## Continuation and human input

`stop_after_job` runs at most one job per eligible project per worker invocation.
`continue_project_queue` keeps claiming eligible jobs until empty or stopped.
Dependencies must reference existing shipped jobs; blocked dependencies are skipped
when other independent work exists. A decomposition automatically chains its jobs.
Project queues initially use submission/decomposition order. Project weights select
dispatch turns when multiple project queues have work.

Execution capacity defaults to **one slot**, preserving the behavior of existing
installations. Raising `execution.capacity` lets one worker run compatible project
heads concurrently. The durable configuration contract also records per-project
limits, runtime capability requirements, and integer resource limits/requirements.
A project cannot declare more concurrency or resources than the global execution
policy provides. Local workers reserve inside their exclusive worker lease;
PostgreSQL workers persist the complete reservation on the job lease and select it
atomically with the job. Repository and delivery targets are exclusive reservation
locks, while counted resources can be shared up to their configured limits. Each
invocation is bounded by `max_jobs_per_run`; rerun the worker to handle additional
queued or newly submitted requests.

A reservation is released only after the owned attempt and its runtime have stopped.
When `review_after_shipping` pauses continuation, the execution slot is released but
the durable `review_required` project gate remains until an operator resumes it.

Weighted dispatch progress is stored in `system_metadata.execution_scheduler`.
Its allocation counters, selection sequence, and timestamps survive worker restarts,
so restarting a worker does not reset a project's place in weighted allocation.
Every scheduling round also persists the considered project queue heads and their
allocation or deferral result. Status projections expose each slice's eligibility,
project queue position, weight and weighted-allocation rank, capability fit, and
the capacity, project-limit, counted-resource, dependency, or lock constraint that
caused a deferral. These explanations are rebuilt from scheduler state after restart;
worker stdout is not an audit source.

Approval refers to the current item revision, so stale answers cannot approve
revised work:

```sh
node src/cli.js depot approve --state-dir STATE --config CONFIG \
  --id ITEM_ID --revision REVISION --actor operator
node src/cli.js depot clarify --state-dir STATE --config CONFIG \
  --id ITEM_ID --actor operator --project PROJECT_ID --text "Your answer"
node src/cli.js depot run --state-dir STATE --config CONFIG
```

Here `STATE`, `CONFIG`, and IDs stand for values returned by your submission/status.
Approval cannot bypass insufficient confidence, missing checks, or conflicting
configuration. Material project context/policy changes after a decision block
execution and require a new decision. Clarification preserves original input.

Every work slice has a trusted `action_class`: `read_only`, `consequential`, or
`human_task`. Declaring the `external-action` capability sets a minimum class of
`consequential`; declaring `human-task` sets `human_task`. A model or Depot request
may elevate that classification but cannot downgrade it or waive approval.
Read-only research may proceed under normal project autonomy. Consequential calls
remain in Review until a human approval is bound to the current item revision,
exact work digest, and project policy digest. The Engine validates that scope again
immediately before invoking an execution provider, so stale approval cannot cross
a revised action or policy boundary.

Human tasks never run through an autonomous execution provider. Once their scope
is approved, they remain in Review with a durable `unassigned` status. Assignment
records the assignee, assigning actor, timestamp, and a new job revision. Completion
must reference that current revision and include a human actor, summary, and at
least one durable evidence reference. Only that explicit completion transition
marks the job Shipped; it records `human-task` delivery evidence and no executor
attempt. CLI integrations can use `depot assign-human-task` and
`depot complete-human-task`; the JSON API exposes matching revision-guarded job
endpoints.

`depot stop --state-dir STATE --project PROJECT_ID` stops future jobs after the
current attempt finishes. `depot resume --state-dir STATE --project PROJECT_ID
--actor operator` clears a stop or post-shipping human gate. A blocked project also
requires `--note "What was inspected and resolved"`; blocked jobs themselves are
never rerun by resume. Submit replacement work with a new key after inspection.

An integration can satisfy or revoke a declared condition without impersonating a
human answer:

```sh
node src/cli.js depot signal-condition --state-dir STATE --config CONFIG \
  --key source.imported --satisfied true --actor importer
```

Each signal increments a durable revision and records the actor, observation time,
and optional details. Eligibility history explains when and why a waiting job moved
between waiting and eligible.

## Failures and restart

Execution/verification retries are bounded by `max_rework_attempts` (0–10).
The next attempt receives the previous failure evidence. Exhausting rework places a
job-scoped hold on that slice and its dependency descendants; independent Ready jobs
in the same project may continue. Shipping errors do not trigger automated execution
retries: a network failure may hide a successful push. Unknown remote outcomes,
interrupted attempts, and unreconciled external-side-effect conditions quarantine the
project until an operator inspects and resumes it. Status reports the specific job
hold or project quarantine cause and retains the underlying evidence.

Execution-provider fallback is limited to providers explicitly listed in
`execution.providers` that satisfy the job's required capabilities. A provider may
report a structured `provider_failure` with category `quota`, `authentication`, or
`availability` and either `safe_to_retry: true` or an `action_status` of `none`,
`not_started`, or `pre_action`. Roundhouse then records the failure, closes that
attempt, and selects a different compatible provider for a new attempt. Provider
selection never changes inside an active attempt, and safe provider fallback does
not consume the work-repair budget. An uncertain or started external action blocks
for reconciliation; it is never replayed. Exhausting compatible providers produces
a durable Blocked result naming the unavailable capability or dependency.

With the local adapter, state writes are atomic fsynced snapshots and recovery
refuses live/remote filesystem owners. With PostgreSQL, nodes use expiring heartbeat
leases; claims, dependencies, capacity, project limits, counted resources, and
exclusive repository/delivery locks are checked in one transaction across nodes.
Recovery marks expired active work, including a Ready job with an uncertain expired
reservation, Blocked and never guesses whether a push happened. Inspect the retained
commit, branch and remote before resuming. A persisted delivery intent
always requires reconciliation. Database loss stops autonomous work; there is no
stale local fallback or offline multi-master mode.

This is at-most-one automatic execution with explicit crash reconciliation, not
an exactly-once guarantee across external Git servers. External side effects are
recorded as intent before shipping and confirmed before Shipped is persisted.

## Tests as behavior contracts

`npm test` runs the full suite; `npm run test:unit` covers policy/state/input
contracts; `npm run test:e2e` runs integration and end-to-end repository
scenarios. `npm run acceptance` is the safe deterministic acceptance harness for
the complete local product workflow. It uses only disposable state, disposable
configuration, temporary Git repositories and local bare remotes, deterministic
fixture decision/execution providers, and the safe fixture deployment provider.
It never uses the Inclusion repository, production deployment, hosted Git
providers, or the normal `~/Library/Application Support/Roundhouse` state.
`npm run test:postgres` additionally runs real transaction/locking tests when a
dedicated `TEST_DATABASE_URL` is supplied and otherwise reports explicit skips.

The deterministic acceptance harness proves:

- clean server startup using temporary state and configuration
- browser-facing HTTP/API intake, config save, worker tick, questions, approval,
  status, evidence, and restart reconstruction
- Depot persistence, decision, one meaningful clarification, durable answer
  context, human review, programmatic approval, execution, verification, fixture
  shipping, and completed summary/evidence
- the zero-human path `Depot -> Decision -> Ready -> Execute -> Verify -> Ship -> Completed`
  with `allow_autonomous: true` and `approval_required: false`
- the repository-free Green Family Cemetery path: deterministic sourced research,
  a durable cited artifact, a restart-stable future follow-up, and a scoped
  consequential proposal whose provider cannot run before revision-bound approval
- decision-loop regression protection for the README inspection versus executable
  verification question, including after reconstructing the store from disk
- deterministic allocation evidence for compatible multi-project concurrency,
  capacity-limited weighted turns, blocked project-head bypass, repository lock
  conflicts, and the default one-slot mode
- actual served browser JavaScript in Chrome on an insecure
  `http://roundhouse-compatible` origin, including Enter/Shift+Enter/IME behavior,
  preserved failed submissions, cleared successful submissions, draft preservation
  across polling/rerendering, button submission, rapid double-submit protection,
  configuration validation, and bucket movement

Coverage also includes autonomous shipping, confidence routing,
approval/resumption, verification failure/repair, queue continuation,
stop-after-job, decomposition, duplicate ownership, stale approval, preserved
source work, exact-commit checks, and separate CLI submit/run/status processes.
Test providers exercise real local process execution while keeping model behavior
deterministic. A change to the core Roundhouse workflow is not complete if
`npm run acceptance` fails.
