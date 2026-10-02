#!/bin/zsh
set -euo pipefail
action="${1:-status}"
label="gui/$UID/io.roundhouse.service"
domain="gui/$UID"
plist="$HOME/Library/LaunchAgents/io.roundhouse.service.plist"
case "$action" in
  start)
    launchctl bootstrap "$domain" "$plist" 2>/dev/null || launchctl kickstart -k "$label"
    ;;
  stop) launchctl bootout "$label" ;;
  restart)
    launchctl bootout "$label" 2>/dev/null || true
    launchctl bootstrap "$domain" "$plist" || {
      launchctl bootout "$label" 2>/dev/null || true
      launchctl bootstrap "$domain" "$plist"
    }
    launchctl kickstart -k "$label"
    ;;
  repair) "$0" restart; "$0" smoke ;;
  smoke)
    /usr/bin/curl --noproxy '*' --fail --silent --show-error --max-time 2 -H 'Host: roundhouse' http://127.0.0.1:8787/health | /usr/bin/grep -q '"status":"ok"'
    /usr/bin/curl --noproxy '*' --fail --silent --show-error --max-time 2 http://roundhouse/health | /usr/bin/grep -q '"status":"ok"'
    print "Roundhouse app and front door are healthy."
    ;;
  status) launchctl print "$label" ;;
  *) print -u2 "Usage: service.sh <start|stop|restart|repair|smoke|status>"; exit 64 ;;
esac
