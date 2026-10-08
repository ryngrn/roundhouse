# Unblocker — isolation-first recovery

Unblocker is a dedicated control-plane recovery worker, not a project executor. Its sole goal is to prevent safely independent Ready work from getting trapped behind unrelated blocked work. It uses deterministic evidence rules before considering model-assisted follow-up.

## What happens when a job blocks?

At worker wake, Unblocker reads durable failure evidence, attempts, shipping records, project policy, dependencies, and project-wide holds before triage and dispatch. After a dispatch attempt, it inspects new blocks again. It does not use a recurring timer or generate token-consuming prompts.

- Repair: For a never-started stale context job, call the Engine's existing execution-authority guard. Refresh only non-authority context; leave changed permissions, executors, runtimes, shipping policies, or verification requirements blocked for a human.
- Isolate: For verified local Codex work that failed configured verification, with no remote or delivery uncertainty and branch-only/commit-only shipping, keep the failed job Blocked and its dependents held, but lift the obsolete project-wide hold so independent Ready work can depart.
- Escalate: Remote/Herdr uncertainty, command executors, credential/security changes, deployment uncertainty, interrupted work, and unknown failure categories retain project-wide quarantine. Report the precise blocker for human review; do not guess.

Operator stop and review gates always outrank Unblocker. Never mutate dependencies, replay failed work, grant approvals, delete a lock, claim a shipped outcome, or mark a job Shipped.

## Observability and operation

Worker status includes the Unblocker running flag, last run, result, and error. Releasing a project hold records a project-level audit event with isolated job IDs and timestamp. The affected jobs retain their recorded failures and Blocked states.

To run one pass manually from the production code checkout:

    node src/cli.js depot unblock --state-dir "$HOME/Library/Application Support/Roundhouse/state" --config "$HOME/Library/Application Support/Roundhouse/projects.yaml"

The existing event-driven worker invokes the same pass on wake. For CLI-only execution cycles, call this command before selecting new work; background dispatcher integration must be installed so missed wake signals do not recreate global logjams.

## Acceptance

A local verification failure isolates only that job. An independent Ready job executes and ships normally; a dependent Ready job does not. Changed authority, remote uncertainty, operator stops, and review gates cannot be cleared. A second Unblocker run performs no duplicate release, and a worker wake reports its action without adding polling.

## Recovery questions in chat and the web portal

A blocked root job or unplanned blocked item receives one small follow-up intake item with a single focused question. The new item appears in **Needs a signal** on the local and hosted Roundhouse portal. It preserves the original job ID, blocker category, failure evidence, and known conversation correlation. It does not replay the blocked job.

- In the web portal, open the recovery item, answer its decision question, and submit. The existing revision-guarded decision-session endpoint evaluates the answer and may plan a new repair. Stale or duplicate answers fail without modifying the original attempt.
- In ChatGPT, Roundhouse's get_needs_human MCP tool lists the same durable question IDs, and answer_question records a current answer for evaluation. The normal Roundhouse outbox emits a Needs Clarification event for connected notification consumers.
- Automatically posting an unsolicited message into the original ChatGPT thread is not supported by the existing transport: correlation metadata is preserved when present, but an approved thread-addressable delivery connector is required to actually push into a specific existing conversation.

Generation is bounded to three new root-blocker questions per worker wake and deduplicated by original entity ID. Dependency-held Ready descendants receive no redundant questions; already answered/repeated decisions and prior recovery follow-ups do not recursively create questions. No state write occurs on an idle pass with nothing to create.

Answers never directly mark the original job Shipped or clear uncertain remote execution holds. The ordinary Roundhouse policy, verification and approval gates still apply to any newly proposed repair.
