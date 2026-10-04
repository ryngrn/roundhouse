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

Each Depot item has a decision lifecycle and may produce up to eight sequential
work jobs. Each job has its own execution lifecycle. The status command presents
the aggregate item state; all jobs must ship before the item displays Shipped.
The original request, clarifications, durable questions and answers, prior decisions,
project context, and job attempts remain on disk. Each question has a stable ID and
revision. Answering one records the response and immediately repeats decision and
readiness evaluation; execution remains separately owned by the worker.

The Codex decision provider returns structured JSON: likely project, project and
execution confidence, context sufficiency, safety/approval judgments, dependencies,
outcomes, executable acceptance criteria, runtime, executor, shipping policy, and
an optional stable `decision_key` for a clarification or review decision.
Confidence is a model judgment, not a statistical guarantee. Deterministic policy
enforces configurable thresholds, project matching, approval requirements, and
permitted runtime/delivery choices. Neither input text nor an imported legacy Ready flag can
override project policy. Only concise decision metadata is stored; Codex reasoning
traces are discarded, and sessions use ephemeral mode.

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
provider's configured argv contract. Selection is provider-neutral: Roundhouse picks
the matching provider with the fewest unrelated capabilities and uses its ID as the
stable tie-breaker. Capabilities that exist only across separate providers are not
silently composed, so unsupported combinations remain Ready but unallocated with
durable `provider_unavailable` evidence. Research, connected-source work, scheduling,
artifact persistence, external actions, and human-task handling are ordinary
capability identifiers; the workflow contains no policy specific to any provider.
Repository-free command providers may return a summary and other JSON records and
may write artifact files in their workspace. At least one structured result or file
is required. Roundhouse records a run UUID, provider ID, input digest, attempt state,
failures, evidence, immutable output reference, and reconciliation state.

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
The execution runtime is instructed not to push; delivery belongs to Roundhouse.

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

`depot stop --state-dir STATE --project PROJECT_ID` stops future jobs after the
current attempt finishes. `depot resume --state-dir STATE --project PROJECT_ID
--actor operator` clears a stop or post-shipping human gate. A blocked project also
requires `--note "What was inspected and resolved"`; blocked jobs themselves are
never rerun by resume. Submit replacement work with a new key after inspection.

## Failures and restart

Execution/verification retries are bounded by `max_rework_attempts` (0–10).
The next attempt receives the previous failure evidence. Shipping errors do not
trigger automated execution retries: a network failure may hide a successful push.
Blocked projects stop taking new jobs until reconciled. Other projects can progress.

With the local adapter, state writes are atomic fsynced snapshots and recovery
refuses live/remote filesystem owners. With PostgreSQL, nodes use expiring heartbeat
leases; claims, dependencies, capacity, project limits, counted resources, and
exclusive repository/delivery locks are checked in one transaction across nodes.
Recovery marks expired active work, including a Ready job with an uncertain expired
reservation, Blocked and never guesses whether a push happened. Inspect the retained
commit, branch and remote before resuming. A persisted delivery intent
always requires reconciliation. Database loss stops autonomous work; there is no
stale local fallback or offline multi-master mode.

For a blocked `push_branch` job whose candidate worktree is still present, an
operator may run `roundhouse depot reconcile-job --state-dir STATE --config CONFIG
--id JOB_ID`. Roundhouse first refuses an existing divergent remote job branch,
then reruns the configured checks against the exact retained commit. It can create
only the original `codex/roundhouse-JOB_ID` branch with a normal non-force push
when that branch is absent, and marks the job Shipped only after `ls-remote`
confirms the exact commit. It cannot redirect recovery to a default/protected
branch or change the job's original `push_branch` authority.

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
