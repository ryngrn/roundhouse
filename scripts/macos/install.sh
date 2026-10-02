#!/bin/zsh
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This installer targets macOS."
  exit 1
fi
script_dir="${0:A:h}"
repo="${script_dir:h:h}"
node_bin="$(command -v node)"
support="$HOME/Library/Application Support/Roundhouse"
agents="$HOME/Library/LaunchAgents"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cd "$repo"
npm ci
mkdir -p "$support" "$agents"
chmod 700 "$support"
if [[ ! -f "$support/projects.yaml" ]]; then
  cp "$repo/config/local.empty.yaml" "$support/projects.yaml"
  chmod 600 "$support/projects.yaml"
fi
node "$repo/scripts/macos/generate.mjs" "$stage" "$repo" "$node_bin" "$HOME"
cp "$stage/io.roundhouse.service.plist" "$agents/io.roundhouse.service.plist"

launchctl bootout "gui/$UID/io.roundhouse.service" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$agents/io.roundhouse.service.plist"

sudo cp "$stage/io.roundhouse.front-door.plist" /Library/LaunchDaemons/io.roundhouse.front-door.plist
sudo chown root:wheel /Library/LaunchDaemons/io.roundhouse.front-door.plist
sudo chmod 644 /Library/LaunchDaemons/io.roundhouse.front-door.plist
if ! grep -q '^# BEGIN ROUNDHOUSE$' /etc/hosts; then
  print '# BEGIN ROUNDHOUSE\n127.0.0.1 roundhouse\n# END ROUNDHOUSE' | sudo tee -a /etc/hosts >/dev/null
fi
sudo launchctl bootout system/io.roundhouse.front-door 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/io.roundhouse.front-door.plist
print "Roundhouse installed. Open http://roundhouse"
