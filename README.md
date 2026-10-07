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

## Sync the private web dashboard

When `ROUNDHOUSE_RELAY_DATABASE_URL` is configured on the Studio machine, the
Depot CLI can claim changes made from `roundhouse.ryan.green`, apply them to the
local workflow state, and publish a fresh dashboard projection:

```sh
node src/cli.js depot relay --state-dir /absolute/path/to/state \
  --config /absolute/path/to/autonomy.yaml
```

Remote intake may include up to eight image/PDF asset descriptors. To enable
those downloads, set `ROUNDHOUSE_RELAY_ASSET_BASE_URL` to the dashboard's HTTPS
asset endpoint and `ROUNDHOUSE_RELAY_ASSET_BEARER_TOKEN` to its dedicated worker
credential. The worker derives download and thumbnail URLs from each asset UUID;
commands cannot supply URLs. Verified files are stored with private permissions
under the state directory's `assets` folder. Keep that folder outside project
repositories and output directories.

For the normal always-on Studio process, set `ROUNDHOUSE_WAKE_SUBSCRIBE_URL` to
the same private ntfy topic used by the dashboard and run:

```sh
node src/cli.js depot relay-watch --state-dir /absolute/path/to/state \
  --config /absolute/path/to/autonomy.yaml
```

`relay-watch` also runs a reconciliation heartbeat every 60 minutes by default,
so missed wake messages do not leave remote changes stranded. Adjust it with
`--heartbeat-minutes`, or set it to `0` to rely only on wake messages.

`depot run` also processes queued relay commands before executing work and
publishes a fresh projection afterward when the relay database URL is present.
Use `publish-dashboard` when you only need to refresh the web view:

```sh
node src/cli.js depot publish-dashboard --state-dir /absolute/path/to/state \
  --config /absolute/path/to/autonomy.yaml
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
