#!/bin/bash
set -euo pipefail
if [[ $(id -u) -ne 0 ]]; then
  echo 'Run with administrator privileges: sudo bash macos/retire-local-browser.sh' >&2
  exit 1
fi
stamp=$(date +%Y%m%d-%H%M%S)
backup="/var/backups/roundhouse-browser-$stamp"
mkdir -p "$backup"
cp /etc/hosts "$backup/hosts"
plist=/Library/LaunchDaemons/io.roundhouse.front-door.plist
if [[ -f "$plist" ]]; then
  cp "$plist" "$backup/front-door.plist"
  launchctl bootout system/io.roundhouse.front-door 2>/dev/null || true
  mv "$plist" "$backup/front-door.plist.disabled"
fi
python3 - <<'PY'
p='/etc/hosts'
with open(p) as f: lines=f.readlines()
lines=[line for line in lines if not (line.strip().endswith(' roundhouse') and line.strip().startswith('127.0.0.1'))]
with open(p,'w') as f:f.writelines(lines)
PY
dscacheutil -flushcache || true
killall -HUP mDNSResponder 2>/dev/null || true
echo "Retired obsolete local browser entry point. Backup: $backup"
echo 'Roundhouse engine remains at http://127.0.0.1:8787'
