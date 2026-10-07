# Depot to delivery

Depot holds incoming requests in their original wording. Submit an idea as text,
JSON, or an exported Notion page, then run the worker. The same workflow interprets
the request, creates executable work, verifies it, and delivers it. No manual
status movement is required for a successful autonomous job.

## Behavior

The work lifecycle is Depot → Decision → Ready → Executing → Verification →
Shipped. Low confidence or insufficient acceptance checks lead to Needs
Clarification. A material human decision leads to Review. Execution or verification
failure can enter Rework, then another execution attempt. Exhausted attempts,
infrastructure errors, or uncertain delivery lead to Blocked.

Review means a human decision is required. Successful execution does not itself
create Review. `review_after_shipping` can separately pause the project's queue
for human continuation approval while the delivered job remains Shipped.

Each Depot item has a decision lifecycle and may produce up to eight sequential
work jobs. Each job has its own execution lifecycle. The status command presents
the aggregate item state; all jobs must ship before the item displays Shipped.
The original request, clarifications, prior decisions, project context, and job
attempts remain on disk.

Project is the highest organization level. An item may carry an optional `goal_id`,
but a goal is project-scoped metadata and is never used in place of project
classification. Ambiguous project classification asks for the project first.
Refinement then proceeds one current question at a time; each answer records the
question it answered, and prior decisions and answers are supplied to the next
decision pass. State written before structured questions existed remains readable
and is adapted when the next clarification is submitted.

The Codex decision provider returns structured JSON: likely project, project and
execution confidence, context sufficiency, safety/approval judgments, dependencies,
outcomes, executable acceptance criteria, runtime, executor, and shipping policy.
Confidence is a model judgment, not a statistical guarantee. Deterministic policy
enforces configurable thresholds, project matching, approval requirements, and
permitted runtime/delivery choices. Neither input text nor a Notion Ready flag can
override project policy. Only concise decision metadata is stored; Codex reasoning
traces are discarded, and sessions use ephemeral mode.

Acceptance criteria must name existing verification command IDs. Every configured
verification command runs, even if only some IDs are referenced by the decision.
The decision agent must ask for clarification when those checks cannot establish
the outcome. Automated tests establish what they actually check, not arbitrary
product correctness; select meaningful project checks.

Each classified item also exposes a local-first compute advisory. The advisory is
informational: it recommends local compute only when the project's configured
runtime is local, and explicitly retains a configured non-local runtime. Runtime,
executor, and shipping mismatches still route to clarification and can never be
overridden by the advisory.

## Try it without credentials

From this repository:

```sh
npm install
npm test
npm run check
npm run demo
```

The demo creates a temporary project and bare Git remote, uses deterministic
decision/execution subprocesses, delivers two changes, checks their pushed SHAs,
and prints a product result with `passed: true`. It retains its temporary directory
and `demo-result.json` for inspection. It never contacts a hosted Git provider.
`npm run demo -- --live` exercises the same workflow using your authenticated
Codex CLI for both interpretation and execution. It may use model quota. Set
`ROUNDHOUSE_CODEX_BIN` if Codex is not on PATH. `npm run demo -- --live --claude`
does the same with your authenticated Claude Code CLI; set `ROUNDHOUSE_CLAUDE_BIN`
if `claude` is not on PATH.

## Claude Code

Set `decision.kind: claude` and/or a project's `executor.kind: claude`. Both run
`claude -p` headless with session persistence disabled. Decisions run with no
tools and `--json-schema`, so Claude Code returns the decision object directly.
Execution runs in the job worktree with `--permission-mode acceptEdits` and an
explicit `allowed_tools` list (default `Read, Edit, Write, Glob, Grep`). Anything
outside that list, including every shell command, is denied rather than prompted.
Add narrow rules such as `Bash(npm test:*)` when the executor should run checks
itself; Roundhouse still runs the configured verification afterwards. Only the
final result summary is retained. A result marked as an error fails the attempt
even when the process exits 0. Claude Code jobs ship on `claude/roundhouse-<job-id>`.

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
content is rejected. JSON input uses `text`, optional `project_id`, optional
project-scoped `goal_id`, `source`, and `actor`. Text submissions also accept
`--goal`. Explicit project selection is checked against the decision. Without it,
the decision provider infers a project from the configured project context.

## Shipping and verification

The engine creates an isolated worktree on `codex/roundhouse-<job-id>` (or
`claude/roundhouse-<job-id>` for the Claude Code executor), executes the
work there, commits a candidate, and tests that exact commit. Changes made during
verification invalidate it. Failed candidates are retained locally but not shipped.
The execution runtime is instructed not to push; delivery belongs to Roundhouse.

Implemented delivery policies:

- `push_branch` (default): push the verified commit to its job branch and confirm
  that the remote reports the expected SHA. It does not merge or deploy.
- `commit_only`: retain the verified local branch and commit without pushing.

`create_pull_request`, `merge_to_main`, and `deploy` are recognized policy values
but block before execution until their provider is implemented. They never fall
back silently to another delivery mode. Git commit and push hooks are disabled for
engine-owned delivery; declare required checks explicitly in verification policy.

Delivery evidence includes repository, remote, branch, commit, verification command
arguments, output, exit codes, timestamps, and nullable PR/deployment fields.
Project commands are trusted executable configuration, not model-generated shell
strings. Local command executors are not a security sandbox; Codex uses its
workspace-write sandbox, and Claude Code is limited to its configured tool allowlist. Use trusted projects and commands.

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

This first local worker has **one execution slot per state directory**. A worker
lease and repository lease prevent simultaneous ownership. It does not yet open
parallel CLI windows across projects. `max_concurrent_runs` is retained in the
domain configuration for later capacity expansion, not advertised as active
parallel execution. Each invocation is bounded by `max_jobs_per_run`; rerun the
worker to handle additional queued or newly submitted requests.

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

State writes are atomic, fsynced snapshots. A crash leaves the worker lease behind.
Run `depot recover --state-dir STATE` after the worker and its recorded subprocesses
have stopped. Recovery refuses live/remote owners, marks interrupted work Blocked,
and releases recorded dead-worker leases. It does not guess whether a push happened.
Inspect the retained commit, branch and remote before resuming. Incomplete owner
metadata or an interrupted state-store transaction requires manual inspection;
never delete a lock merely because it appears old. The store targets one local
filesystem, not network storage or multiple hosts.

This is at-most-one automatic execution with explicit crash reconciliation, not
an exactly-once guarantee across external Git servers. External side effects are
recorded as intent before shipping and confirmed before Shipped is persisted.

## Tests as behavior contracts

`npm test` runs the full suite; `npm run test:unit` covers policy/state/input contracts;
`npm run test:e2e` runs integration and end-to-end repository scenarios. Tests use
temporary repositories and local bare remotes, not real Notion pages or hosted repos.
Coverage includes autonomous shipping, confidence routing, approval/resumption,
verification failure/repair, queue continuation, stop-after-job, decomposition,
duplicate ownership, stale approval, preserved source work, exact-commit checks,
and separate CLI submit/run/status processes. Test providers exercise real local
process execution while keeping model behavior deterministic.
