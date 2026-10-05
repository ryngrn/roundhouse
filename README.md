# Roundhouse

Roundhouse turns incoming ideas in the **Depot** into policy-controlled work:
interpret the request, resolve the project, execute, verify, ship, and optionally
continue the project's queue. Review means a human decision is needed.

The autonomous vertical slice runs locally, with a durable workflow and replaceable
decision, execution, verification, shipping, and source adapters. Codex, Claude Code,
and trusted command executors are supported. Shipping currently means a verified local commit
or a verified commit pushed to a job branch; production deployment is not enabled.

## Run the complete demonstration

Requires Node.js 20.11+ and Git:

```sh
npm install
npm test
npm run check
npm run demo
```

The demo executes two jobs against a temporary repository and local bare remote,
verifies their commits, confirms both pushes, and requires no model credentials.
For a live model-backed demo using your authenticated Codex CLI:

```sh
npm run demo -- --live
```

Or with your authenticated Claude Code CLI for both interpretation and execution:

```sh
npm run demo -- --live --claude
```

## Use a real project

Start from [the autonomy configuration](config/autonomy.example.yaml), saved outside
your repository. Configure its repository, context, checks, and delivery policy.
Then submit and run:

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
- [Notion Depot bridge and schema migration](docs/chatgpt-rdc-bridge.md)

The worker currently has one local execution slot per state directory. It supports
project queue order and weighted dispatch turns, bounded rework, duplicate guards,
and conservative crash recovery. Herdr, remote/cloud workers, parallel CLI windows,
PR creation, merging, and deployment are extension points rather than active features.

## Earlier interfaces

`capture` remains a local Intake/Brief prototype, using
`config/intake-projects.example.yaml` and `config/intake.example.json`. It does not
execute or approve work.

`dispatch` remains the original Notion/RDC adapter, using
`config/projects.example.yaml`. It requires a Ready item and clean mapped repository,
creates a local commit, and stops at a human delivery gate. Use `depot` for the
verified autonomous shipping workflow. Existing configuration formats remain intact.
