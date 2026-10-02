# Local control room and macOS installation

Roundhouse runs as one loopback-bound Node service containing the browser UI, JSON
API, background worker, and Streamable HTTP MCP endpoint. The macOS front door is a
separate loopback-only LaunchDaemon that maps standard HTTP to the unprivileged
service. `/etc/hosts` maps the single-label name `roundhouse` to `127.0.0.1`.
Consequently the normal browser URL is exactly `http://roundhouse`.

The privileged changes happen only when the operator runs the installer. Tests
only inspect generated configuration and never change launchd, `/etc/hosts`, or
port 80.

## Install and operate

Requires Node.js 20.11+, Git, and macOS command-line developer tools:

```sh
./scripts/macos/install.sh
open http://roundhouse
./scripts/macos/menu-bar.sh install
```

The installer runs `npm ci`, creates (without replacing) the private configuration
at `~/Library/Application Support/Roundhouse/projects.yaml`, installs a user
LaunchAgent for the app and worker, adds a marked `/etc/hosts` block, and installs
a root-owned LaunchDaemon for the loopback port-80 proxy. It asks for `sudo` only
for the latter two system changes.

The menu helper is an unsigned development build made with `swiftc`. It is a native
AppKit menu extra, not another control surface. It can open Roundhouse, show health
and counts, and start, stop, or restart the service. Its durable event cursor
prevents repeat notifications. It notifies only for Needs You, blocked/failure, and
shipped events. Signing, notarization, and a DMG remain release-distribution work
that requires Apple credentials.

Useful commands:

```sh
./scripts/macos/service.sh status
./scripts/macos/service.sh restart
./scripts/macos/menu-bar.sh run
./scripts/macos/menu-bar.sh uninstall
./scripts/macos/uninstall.sh
```

Uninstall removes both launchd jobs and the marked host entry. It deliberately
keeps state and private project configuration in Application Support; the operator
can archive or remove that directory separately.

For a foreground developer run, `npm start` starts the combined service on
`127.0.0.1:8787`, creating an empty private configuration if necessary. The
installed front door is what makes the port-free canonical URL available.

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
