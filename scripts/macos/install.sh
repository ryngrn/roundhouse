#!/bin/zsh
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This installer targets macOS."
  exit 1
fi
script_dir="${0:A:h}"
repo="${script_dir:h:h}"
action="${1:-install}"
node_bin="$(command -v node)"
support="$HOME/Library/Application Support/Roundhouse"
agents="$HOME/Library/LaunchAgents"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

app_health() {
  /usr/bin/curl --noproxy '*' --fail --silent --show-error --max-time 2 -H 'Host: roundhouse' http://127.0.0.1:8787/health | /usr/bin/grep -q '"status":"ok"'
}

front_health() {
  /usr/bin/curl --noproxy '*' --fail --silent --show-error --max-time 2 http://roundhouse/health | /usr/bin/grep -q '"status":"ok"'
}

wait_for_health() {
  local name="$1" check="$2"
  for attempt in {1..30}; do
    if "$check"; then return 0; fi
    sleep 1
  done
  print -u2 "Roundhouse ${name} health check failed after 30 attempts."
  return 1
}

if [[ "$action" == "smoke" ]]; then
  app_health || { print -u2 "Roundhouse app service is unavailable."; exit 1; }
  front_health || { print -u2 "Roundhouse front door is unavailable."; exit 1; }
  print "Roundhouse app and front door are healthy."
  exit 0
fi
if [[ "$action" != "install" && "$action" != "repair" ]]; then
  print -u2 "Usage: install.sh [install|repair|smoke]"
  exit 64
fi

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
if ! launchctl bootstrap "gui/$UID" "$agents/io.roundhouse.service.plist"; then
  print -u2 "Initial user service bootstrap failed; clearing the stale registration and retrying once."
  launchctl bootout "gui/$UID/io.roundhouse.service" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$agents/io.roundhouse.service.plist"
fi
launchctl kickstart -k "gui/$UID/io.roundhouse.service"

sudo cp "$stage/io.roundhouse.front-door.plist" /Library/LaunchDaemons/io.roundhouse.front-door.plist
sudo chown root:wheel /Library/LaunchDaemons/io.roundhouse.front-door.plist
sudo chmod 644 /Library/LaunchDaemons/io.roundhouse.front-door.plist
if ! grep -q '^# BEGIN ROUNDHOUSE$' /etc/hosts; then
  print '# BEGIN ROUNDHOUSE\n127.0.0.1 roundhouse\n# END ROUNDHOUSE' | sudo tee -a /etc/hosts >/dev/null
fi
sudo launchctl bootout system/io.roundhouse.front-door 2>/dev/null || true
if ! sudo launchctl bootstrap system /Library/LaunchDaemons/io.roundhouse.front-door.plist; then
  print -u2 "Initial front-door bootstrap failed; clearing the stale registration and retrying once."
  sudo launchctl bootout system/io.roundhouse.front-door 2>/dev/null || true
  sudo launchctl bootstrap system /Library/LaunchDaemons/io.roundhouse.front-door.plist
fi
sudo launchctl kickstart -k system/io.roundhouse.front-door

wait_for_health "app service" app_health
wait_for_health "front door" front_health
print "Roundhouse installed and healthy. Open http://roundhouse"
