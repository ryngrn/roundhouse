#!/bin/zsh
set -euo pipefail

support="$HOME/Library/Application Support/Roundhouse"
stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
backup="$support/browser-rollbacks/$stamp"
plist="/Library/LaunchDaemons/io.roundhouse.front-door.plist"
mkdir -p "$backup"

sudo launchctl bootout system/io.roundhouse.front-door 2>/dev/null || true
if [[ -f "$plist" ]]; then
  sudo cp "$plist" "$backup/io.roundhouse.front-door.plist"
  sudo rm -f "$plist"
fi
sudo cp /etc/hosts "$backup/hosts.before"
temporary="$(mktemp)"
awk '
  /^# BEGIN ROUNDHOUSE$/ { skip=1; next }
  /^# END ROUNDHOUSE$/ { skip=0; next }
  !skip && !($1 == "127.0.0.1" && $2 == "roundhouse") { print }
' /etc/hosts > "$temporary"
sudo tee /etc/hosts < "$temporary" >/dev/null
rm -f "$temporary"

print "Retired http://roundhouse. Rollback files: $backup"
