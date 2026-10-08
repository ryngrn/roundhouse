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
# Unblocker belongs to the installed production app code line, not this CLI
# checkout. Resolve the currently installed LaunchAgent repo at every tick so a
# released version replaces the previous one without hardcoded version paths.
# Fail closed on recovery errors, but keep ordinary verified dispatch available.
app_plist="$home/Library/LaunchAgents/io.roundhouse.service.plist"
if [[ -f "$app_plist" ]]; then
  app_repo="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:3' "$app_plist" 2>/dev/null || true)"
  if [[ -n "$app_repo" && -f "$app_repo/src/workflow/unblocker.js" ]]; then
    if unblock_result="$(/opt/homebrew/bin/node "$app_repo/src/cli.js" depot unblock --state-dir "$state_dir" --config "$config" 2>&1)"; then
      printf '%s' "$unblock_result" | /opt/homebrew/bin/node -e '
        let data="";process.stdin.on("data",x=>data+=x).on("end",()=>{
          try {
            const result=JSON.parse(data);
            if ((result.refreshed??0)>0 || (result.released_projects??[]).length>0)
              console.log(new Date().toISOString()+" [unblocker] "+JSON.stringify({
                refreshed:result.refreshed,released_projects:result.released_projects
              }));
          } catch { console.error("[unblocker-error] Invalid recovery report."); }
        });
      '
    else
      # Unblocker errors cannot authorize any retry or bypass a held job.
      printf '%s [unblocker-error] recovery pass failed, all holds retained.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >&2
    fi
  fi
fi
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
