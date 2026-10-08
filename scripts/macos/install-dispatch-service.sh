#!/bin/zsh
set -euo pipefail
if [[ "${1:-}" != "install" && "${1:-}" != "uninstall" ]]; then
  echo "Usage: $0 install|uninstall" >&2
  exit 64
fi
runtime="$HOME/Library/Application Support/Roundhouse"
plist="$HOME/Library/LaunchAgents/io.roundhouse.dispatch.plist"
label="io.roundhouse.dispatch"
domain="gui/$(id -u)"
if [[ "$1" == "uninstall" ]]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "Dispatcher unloaded; archived state and logs preserved."
  exit 0
fi
mkdir -p "$runtime" "$HOME/Library/LaunchAgents"
install -m 700 "$(dirname "$0")/dispatch-once.sh" "$runtime/dispatch-once.sh"
install -m 700 "$(dirname "$0")/triage-once.mjs" "$runtime/triage-once.mjs"
python3 - "$plist" "$runtime" <<'PY'
import plistlib,sys
from pathlib import Path
p=Path(sys.argv[1]);runtime=Path(sys.argv[2])
config=dict(Label='io.roundhouse.dispatch',
ProgramArguments=['/bin/zsh',str(runtime/'dispatch-once.sh')],
RunAtLoad=True,StartInterval=300,ThrottleInterval=30,
StandardOutPath=str(runtime/'dispatch.log'),
StandardErrorPath=str(runtime/'dispatch-error.log'),
EnvironmentVariables=dict(PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'))
p.write_bytes(plistlib.dumps(config))
p.chmod(0o600)
PY
plutil -lint "$plist" >/dev/null
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
echo "Dispatcher installed and scheduled every 5 minutes; one verified eligible job at most per run."
