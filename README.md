# Roundhouse

[Public documentation and onboarding](https://ryngrn.github.io/roundhouse/)

Roundhouse turns incoming ideas in the **Depot** into policy-controlled work:
interpret the request, resolve the project, execute, verify, ship, and optionally
continue the project's queue. Review means a human decision is needed.

The complete vertical slice runs locally, with a durable workflow and replaceable
decision, execution, verification, shipping/deployment, and source adapters. The
browser control room, JSON API, MCP endpoint, and background worker run in one
loopback service. Codex and trusted command executors are supported; deployments
use an explicit fixture or operator-owned command provider.

Roundhouse is the authoritative system for Depot intake and every downstream
workflow state. The former Notion Roundhouse Depot is archive/reference only; new
“add to Depot” requests go directly to Roundhouse.

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
state or real project data. `npm run acceptance:live` additionally tries the real
local Codex executor against a disposable repository and reports an explicit skip
when Codex is unavailable.

## Use a real project

Start from [the autonomy configuration](config/autonomy.example.yaml), saved outside
your repository, or use the control room's validated private configuration editor.
Configure its repository, context, checks, and delivery policy. The installed
background worker automatically notices new and newly answered work. CLI operation
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

- [Behavior, configuration, approvals, recovery, and test contracts](docs/autonomous-workflow.md)
- [Architecture and adapter extension guide](docs/architecture.md)
- [Notion Depot archive and one-time cutover](docs/chatgpt-rdc-bridge.md)
- [ChatGPT MCP adapter setup and testing](docs/chatgpt-mcp.md)

The worker has one local execution slot per state directory. It supports
project queue order and weighted dispatch turns, bounded rework, duplicate guards,
and conservative crash recovery. Herdr, remote/cloud workers, parallel CLI windows,
PR creation, and merging remain extension points. Deployment is available through
the fixture provider for proof and a configurable command provider for real systems.

## Earlier interfaces

`capture` remains a local Intake/Brief prototype, using
`config/intake-projects.example.yaml` and `config/intake.example.json`. It does not
execute or approve work.

The original Notion/RDC `dispatch` prototype is retired and no longer exposed by
the Roundhouse CLI. There is no supported Notion pickup, status write-back, or
bidirectional sync path.
