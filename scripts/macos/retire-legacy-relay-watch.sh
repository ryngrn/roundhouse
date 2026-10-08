#!/bin/zsh
set -euo pipefail

support="$HOME/Library/Application Support/Roundhouse"
agents="$HOME/Library/LaunchAgents"
stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
backup="$support/relay-watch-rollbacks/$stamp"
plist="$agents/io.roundhouse.relay-watch.plist"
label="gui/$UID/io.roundhouse.relay-watch"
mkdir -p "$backup"

launchctl bootout "$label" 2>/dev/null || true
if [[ -f "$plist" ]]; then
  cp "$plist" "$backup/io.roundhouse.relay-watch.plist"
  rm -f "$plist"
fi

print "Retired the legacy relay watcher; the local engine now owns Aiven wake, command, and projection duties. Rollback: $backup"
