# Roundhouse

[Public documentation and onboarding](https://ryngrn.github.io/roundhouse/)

Roundhouse turns incoming ideas in the **Depot** into policy-controlled work. A
continuous triage control plane interprets and classifies requests, reconciles exact
duplicates, slices broad work, asks only decision-changing questions, and makes safe
work Ready. A separate dispatcher claims eligible work, executes, verifies, ships,
and optionally continues the project's queue.

The complete vertical slice can run locally or across nodes, with a durable workflow and replaceable
decision, conversation, execution, verification, shipping/deployment, and source adapters. The
browser control room, JSON API, MCP endpoint, and background worker run in one
loopback service. Codex, Claude Code, and trusted command executors are supported. Model-agent
prompts prefer low-token AXI interfaces for supported GitHub and browser operations,
with the existing tools as bounded fallbacks; AXI is an execution-tool preference,
not a control plane or runtime. Deployments use an explicit fixture or
operator-owned command provider.

The control room is project-first: dense work rows expose operational state at a
glance, while a large details dialog keeps briefs, evidence, history, and atomic
multi-question decision sessions out of the main dashboard.

Roundhouse is the authoritative system for Depot intake and every downstream
workflow state. The former Notion Roundhouse Depot is archive/reference only; new
“add to Depot” requests go directly to Roundhouse.

For shared/multi-node installs, PostgreSQL is authoritative; Neon is the intended
hosted provider. Local JSON storage is only for explicit single-node development,
tests, and pre-cutover bootstrap. See the [PostgreSQL control-plane and cutover
guide](docs/postgresql-control-plane.md). The idle control plane uses disposable
wakes with a five-minute PostgreSQL relay reconciliation fallback;
see the [wake, read, and execution boundaries](docs/event-driven-control-plane.md).

## Install on one Mac

```sh
./scripts/macos/install.sh
open http://roundhouse
./scripts/macos/menu-bar.sh install
```

The explicit installer creates the durable, reversible local hostname/front-door
setup. Normal use is at exactly `http://roundhouse`; no port is required. See
[local setup, operation, project configuration, and uninstall](docs/local-control-room.md).

## Run the complete demonstration

Requires Node.js 20.11+ and Git:

```sh
npm install
npm test
npm run check
npm run acceptance
npm run demo
```

The demo executes two jobs against a temporary repository and local bare remote,
verifies their commits, confirms both pushes, and requires no model credentials.
For a live model-backed demo using your authenticated Codex CLI:

```sh
npm run demo -- --live
```

`npm run acceptance` is the safe deterministic QA harness for the complete
Roundhouse flow. It uses temporary state, temporary repositories, fixture
deployment, and real browser/API paths without touching normal local Roundhouse
state or real project data. It also proves the repository-free Green Family
Cemetery workflow with fixture-only sources, durable outputs, a future follow-up,
and an approval-gated action proposal that has no real external effect.
`npm run acceptance:live` additionally tries the real
local Codex executor against a disposable repository and reports an explicit skip
when Codex is unavailable.

## Use a real project

Start from [the autonomy configuration](config/autonomy.example.yaml), saved outside
your repository, or use the control room's validated private configuration editor.
Configure its repository, context, checks, and delivery policy. The installed
background worker runs on startup, local mutations, and disposable wake messages,
with a five-minute PostgreSQL relay reconciliation fallback. CLI operation
remains available:

```sh
node src/cli.js depot submit --state-dir /absolute/path/to/state \
  --key request-001 --project example --text "The improvement you want"
node src/cli.js depot run --state-dir /absolute/path/to/state \
  --config /absolute/path/to/autonomy.yaml --project example
node src/cli.js depot status --state-dir /absolute/path/to/state
```

For Roundhouse itself, [the self-development configuration](config/roundhouse.autonomy.yaml)
is ready to use after committing local changes. It verifies dependencies, tests,
syntax, and whitespace, then pushes a job branch and stops after one job. Its paths
are repository-relative and contain no personal machine settings.

Herdr projects can use shared-worktree execution or explicit `machine_local` mode
for a repository that exists only on the fleet machine. See the
[shipping and verification contract](docs/autonomous-workflow.md#shipping-and-verification)
and the iMac example in [the autonomy configuration](config/autonomy.example.yaml).
Herdr remains the preferred fleet runtime; AXI runs beneath the selected local or
Herdr executor and requires no per-project manifest setting.

- [Behavior, configuration, approvals, recovery, and test contracts](docs/autonomous-workflow.md)
- [Architecture and adapter extension guide](docs/architecture.md)
- [Event-driven control-plane wake and read boundaries](docs/event-driven-control-plane.md)
- [PostgreSQL operations, migration, backup, and recovery](docs/postgresql-control-plane.md)
- [Notion Depot archive and one-time cutover](docs/chatgpt-rdc-bridge.md)
- [ChatGPT MCP adapter setup and testing](docs/chatgpt-mcp.md)
- [Claude conversation MCP contract](docs/claude-mcp.md)
- [Mixed Codex/Claude provider operation and failure boundaries](docs/mixed-provider-operation.md)

The local adapter reserves configured execution slots inside one worker lease and
uses an independent triage lease. PostgreSQL workers atomically reserve compatible
capacity with item, job, project, repository, delivery, and counted-resource
constraints across nodes. Both support priority/fair queue order, bounded triage backoff and
rework, exact-identity duplicate guards, and conservative crash recovery. Local is
the default execution runtime; projects may opt into Herdr using an existing
configured remote agent. PR creation and merging remain extension points. Deployment is available through
the fixture provider for proof and a configurable command provider for real systems.

## Earlier interfaces

`capture` remains a local Intake/Brief prototype, using
`config/intake-projects.example.yaml` and `config/intake.example.json`. It does not
execute or approve work. Each capture atomically stores an immutable `intake.json`
and append-only, numbered Brief revisions under `intakes/<intake-id>/briefs/`.
Every audit revision persists derived readiness with stable, human-readable reasons.
A separate material revision advances when outcome, scope, acceptance criteria,
context, decisions, or artifacts change. A Brief is `slice_ready` only when project
context and evidence are valid for that material revision. Lifecycle-only updates
retain still-valid evidence, while material edits make copied approval, decision
references, and required artifacts stale; capture records remain
`execution_eligible: false` even when ready, so this prototype cannot create or
dispatch executable work.

The original Notion/RDC `dispatch` prototype is retired and no longer exposed by
the Roundhouse CLI. There is no supported Notion pickup, status write-back, or
bidirectional sync path.
