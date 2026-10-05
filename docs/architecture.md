# Autonomous workflow architecture

The executable entry point is `roundhouse depot`. The earlier `capture` command
remains a lightweight intake prototype. The earlier `dispatch` command remains a
legacy manual-delivery adapter; it is not the autonomous workflow.

| Boundary | Current implementation | Replacement contract |
| --- | --- | --- |
| Depot source | CLI JSON/text and exported Notion page | Submit immutable input with a stable key |
| Project/context store | YAML/JSON manifests plus local context files | Validated project policy and context snapshot |
| Decision provider | Structured Codex or Claude Code response, or command JSON protocol | `decide({item, projects, directory, onStart})` returns validated decision |
| Durable workflow | Atomic local snapshot store, state machine, Engine | Own claims, transitions, dependencies, human gates and delivery intent |
| Execution runtime | Local subprocess, Codex, Claude Code or configured command | `execute({project, job, workspace, previous_failure, onStart})` returns operational result |
| Verification | Configured argv commands plus unchanged-commit check | `verify({project, workspace, commit, onStart})` returns checks and commit evidence |
| Shipping provider | Git worktree, commit, verified branch push | `supports`, `lock`, `prepare`, `snapshot`, `unchanged`, `ship` |
| Human feedback | CLI approval/clarification and bridge event outbox | Revision-bound human response, durable audit record |

The Engine imports no Notion SDK and contains no Codex or Claude Code command-line flags. Those
belong to adapters. Runtime state is distinct from product state: a process exiting
does not decide that work is Shipped or needs Review.

## Durable ownership

`state.json` contains schema version, immutable Depot inputs, decision history,
jobs, attempts, project queue state, and an outbox. All read-modify-write operations
use a short exclusive state lease, write a new file, fsync, rename, and fsync the
directory. An invocation-wide worker lease serializes claims. A repository lease
prevents another state directory from modifying the same Git common directory
concurrently. Only the owner releases a lease. Contention fails visibly; callers
may retry instead of silently stealing ownership.

Claim intent, runtime process IDs, candidate commits, verification evidence, and
delivery intent are persisted at their boundaries. A restart never assumes an
interrupted external action did not happen. Recovery is conservative and retains
artifacts. No distributed database, queue daemon, or hidden background scheduler is
required for this slice.

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

Implement a provider that acquires resource ownership, prepares the target,
captures an immutable candidate identity, checks identity after verification, and
ships only passing evidence. Return repository/resource reference, branch/version,
commit/artifact identity, timestamp, verification and optional PR/deployment data.
Register supported policies explicitly. A document provider can use artifact
versions in place of Git SHAs while retaining the same lifecycle. Non-code delivery
is not implemented by the current Git adapter.

## Configuration and audit trust

Project policy and verification commands are operator-owned configuration. Model
decisions cannot inject commands or select an unconfigured delivery policy. Input
and provider output are validated at the boundary. The model may still misjudge
semantic correctness; thresholds and tests are controls, not guarantees. State
files are private local data, not a tamper-proof audit system or multi-user auth
service. The `actor` field records the local operator's declared identity.

No hidden chain-of-thought is requested or persisted. Decision records contain only
the schema fields; raw Codex event streams are discarded, and only Claude Code's final result summary is kept. Command-provider output
and verification output are retained as configured operational evidence, so avoid
commands that print secrets.
