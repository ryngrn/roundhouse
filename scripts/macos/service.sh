#!/bin/zsh
set -euo pipefail
action="${1:-status}"
label="gui/$UID/io.roundhouse.service"
domain="gui/$UID"
plist="$HOME/Library/LaunchAgents/io.roundhouse.service.plist"
case "$action" in
  start) launchctl bootstrap "$domain" "$plist" ;;
  stop) launchctl bootout "$label" ;;
  restart)
    launchctl bootout "$label" 2>/dev/null || true
    launchctl bootstrap "$domain" "$plist"
    ;;
  status) launchctl print "$label" ;;
  *) print -u2 "Usage: service.sh <start|stop|restart|status>"; exit 64 ;;
esac
