# Local control room and macOS installation

Roundhouse runs as one loopback-bound Node service containing the JSON API,
background worker, and Streamable HTTP MCP endpoint. It remains available to local
clients at `127.0.0.1:8787`. Browser use is hosted at
`https://roundhouse.ryan.green`; the obsolete port-80 front door and `roundhouse`
hostname mapping, bundled local browser UI, and standalone MCP listener are retired.
Opening the loopback root redirects to the hosted dashboard; API and `/mcp` routes
remain local.

## Install and operate

Requires Node.js 20.11+, Git, and macOS command-line developer tools:

```sh
./scripts/macos/install.sh
open https://roundhouse.ryan.green
./scripts/macos/menu-bar.sh install
```

The installer runs `npm ci`, creates (without replacing) the private configuration
at `~/Library/Application Support/Roundhouse/projects.yaml`, and installs a user
LaunchAgent for the local engine and worker. It makes no hostname or port-80 changes.

The menu helper is an ad-hoc signed native build made with `swiftc`. It is a native
AppKit menu extra, not another control surface. It can open Roundhouse, show local
health and last-known cached counts, and start, stop, or restart the service. Its durable event cursor
prevents repeat notifications. It notifies only for Needs You, blocked/failure, and
shipped events. Signing, notarization, and a DMG remain release-distribution work
that requires Apple credentials.

Useful commands:

```sh
./scripts/macos/service.sh status
./scripts/macos/service.sh restart
./scripts/macos/service.sh repair
./scripts/macos/service.sh smoke
./scripts/macos/install.sh smoke
./scripts/macos/menu-bar.sh run
./scripts/macos/menu-bar.sh uninstall
./scripts/macos/uninstall.sh
```

Install and repair report success only after the local engine's direct health
endpoint returns healthy. A
failed user-service bootstrap is cleared and retried once. The smoke paths are
idempotent and do not unload either service. The menu helper reports app-service
labels data stale when the engine returns a cached snapshot error and counts
unavailable when the engine cannot be reached. Its periodic requests use only
`/api/local-snapshot`. Health remains a local liveness check; each explicit
local-snapshot request refreshes its response from authoritative storage without
waking the worker or performing workflow work.

Uninstall removes the user launchd jobs and also cleans up any legacy front-door
registration or marked host entry. It deliberately
keeps state and private project configuration in Application Support; the operator
can archive or remove that directory separately.

For a foreground developer run, `npm start` starts the combined service on
`127.0.0.1:8787`, creating an empty private configuration if necessary.

## Project configuration

The control room's project editor reads and atomically updates only the private
configuration file. It validates the complete object before replacing the file.
The editor exposes repository, weight, autonomous-review policy, local
runtime/executor, verification commands, shipping policy, and deployment provider.
Checked-in examples are never rewritten.

`config/inclusion.example.yaml` is the first real-project template. Copy its
project object into the control room editor, replace the repository path, verify
the checks and deployment command, and authenticate the real deployment CLI using
its own credential store. Do not put secrets in the YAML.

`deployment.kind: command` receives a JSON packet on stdin containing the verified
commit, workspace, branch, environment, and verification evidence. It must exit
zero and may write one JSON result object to stdout (for example,
`{"status":"succeeded","url":"https://..."}`). A nonzero exit or a status other
than `succeeded` blocks the work. `deployment.kind: fixture` is deterministic,
performs no external action, and exists only for safe tests/demos.

Roundhouse persists delivery intent before push/deploy. An uncertain result is
blocked for reconciliation and is never automatically replayed after a crash.

## Project dashboard and decision sessions

The control room groups compact work rows under configured projects, imported
project candidates, and Unknown / Unassigned. Project headings summarize Needs
You, active, queued, shipped, and blocked work. A row carries workflow state,
priority, agent role, owning node when known, current activity, verification,
shipping, and subordinate import provenance.

Opening a row shows its outcome and brief before expandable intake, acceptance,
prior decisions, evidence, and history. Needs You rows open on Decisions. A
decision session presents one durable question at a time; Back and Next only move
through local drafts. The final `Submit N answers` request includes the item
revision and the complete ordered question/revision set. Roundhouse validates and
persists the whole set in one repository transaction, applies none on conflict,
and invokes decision evaluation once after commit. Polling and manual refresh
continue to update the board without replacing the open dialog or textarea.
