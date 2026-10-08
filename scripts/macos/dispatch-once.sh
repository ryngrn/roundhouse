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
# Process at most one pending Depot/clarification decision before trying dispatch.
# Triage acquires the same worker lock as execution, so decisions never race jobs.
triage_output="$(/opt/homebrew/bin/node "$runtime/triage-once.mjs" 2>&1)" || {
  case "$triage_output" in
    *"Locked:"*"worker.lock"*) exit 0 ;;
  esac
  printf '%s [triage-error] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$triage_output" >&2
  exit 1
}
if [[ -n "$triage_output" ]]; then
  printf '%s [triage] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$triage_output"
fi
# One verified eligible job per activation after bounded Depot triage.
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
