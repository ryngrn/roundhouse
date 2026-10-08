#!/bin/zsh
set -euo pipefail
umask 077
home="${HOME:?}"
runtime="$home/Library/Application Support/Roundhouse"
cd "$home/git/roundhouse"
if [ -f "$runtime/relay.env" ]; then
  set -a
  source "$runtime/relay.env"
  set +a
fi
state_dir="$runtime/state"
config="$runtime/projects.yaml"
# One eligible job per activation. There is no decision-agent/Depot triage here.
# The worker lock prevents overlap, including against a manual CLI run.
output="$(/opt/homebrew/bin/node src/cli.js depot dispatch --state-dir "$state_dir" --config "$config" 2>&1)" || {
  case "$output" in
    *"Locked:"*"worker.lock"*) exit 0 ;;
  esac
  printf '%s [dispatch-error] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$output" >&2
  exit 1
}
# Quiet on idle cycles. Do not echo full state, model output, or secrets.
if printf '%s' "$output" | grep -q '"executed": 1'; then
  printf '%s [dispatch] one job attempted\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
fi
