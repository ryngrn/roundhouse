#!/bin/zsh
set -euo pipefail
agents="$HOME/Library/LaunchAgents"
launchctl bootout "gui/$UID/io.roundhouse.menu" 2>/dev/null || true
launchctl bootout "gui/$UID/io.roundhouse.dispatch" 2>/dev/null || true
launchctl bootout "gui/$UID/io.roundhouse.service" 2>/dev/null || true
rm -f "$agents/io.roundhouse.menu.plist" "$agents/io.roundhouse.dispatch.plist" "$agents/io.roundhouse.service.plist"
sudo launchctl bootout system/io.roundhouse.front-door 2>/dev/null || true
sudo rm -f /Library/LaunchDaemons/io.roundhouse.front-door.plist
temp="$(mktemp)"
awk '/^# BEGIN ROUNDHOUSE$/{skip=1;next}/^# END ROUNDHOUSE$/{skip=0;next}!skip{print}' /etc/hosts > "$temp"
sudo tee /etc/hosts < "$temp" >/dev/null
rm -f "$temp"
print "Roundhouse services and hostname removed. Data remains in ~/Library/Application Support/Roundhouse."
