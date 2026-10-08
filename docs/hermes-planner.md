# Hermes planner (default off)

This adapter replaces only the optional decision command. Raw ideas remain authoritative Depot records on Mac Studio. Studio sends the original input, clarifications, resolved decisions, related-work identities and configured project context to Hermes on iMac. Hermes proposes JSON plans; Studio validates and routes them through existing Review, revision-guarded approval, queue and execution. Aiven is the hosted projection, not an authority or a second planner database. Neon is not used. No polling service, schema migration or execution provider is added.

Plans retain why, goals, scope and non-goals in concise `reason` and slice `outcome`; `work_items` are ordered small sequential slices with acceptance criteria. Broad ideas must set `should_decompose`; that flag or multiple work items forces Review and explicit approval. Stable approval keys include original input, project and proposed slices. Answered keys are suppressed, but text answers never replace Studio’s guarded approval operation. Simple scoped requests retain existing policy autonomy. Missing context, policy conflicts or insufficient confidence still use existing clarification/blocking guards. Model classification of broad single-slice prose is not a deterministic semantic guarantee: inspect it during shadow rollout.

## Studio → iMac setup

These are operator steps for a later rollout, not actions performed by installation or tests.

1. Keep the live Studio decision configuration on Codex. Install Node 20.11+ and a copy of this repo with dependencies on iMac. Use absolute paths; SSH login shells may have a different PATH.
2. Use the already authenticated Hermes provider on iMac. Determine its existing provider ID and model ID yourself without copying secrets into this repo. The adapter requires `ROUNDHOUSE_HERMES_PROVIDER` and `ROUNDHOUSE_HERMES_MODEL` because isolation skips user customizations/config defaults. It passes these as invocation overrides and uses Hermes’s existing authentication. Built-in supported providers (for example `anthropic` or `openrouter`) and models supported by that provider can be used; this repo does not assume a particular model or add authentication. Custom provider definitions relying on ignored config are outside this first slice.
3. Check `hermes chat --help` locally on iMac. This version must support `--query-file`, `--oneshot`, `--quiet`, `--safe-mode`, `--toolsets`, `--max-turns`, `--provider`, and `--model`. The adapter checks help before every invocation and fails closed on missing flags. The implementation was checked against installed CLI source; this worktree’s launcher help failed trying to acquire an installation lock, so no real inference was run.
4. Create an operator-owned wrapper outside source control, e.g. `/Users/planner/bin/roundhouse-hermes`, with actual absolute Node/Hermes/repo paths and existing model/provider IDs:

   ```sh
   #!/bin/sh
   export ROUNDHOUSE_HERMES_BIN=/Users/planner/.local/bin/hermes
   export ROUNDHOUSE_HERMES_PROVIDER=anthropic
   export ROUNDHOUSE_HERMES_MODEL=YOUR_EXISTING_MODEL_ID
   exec /opt/homebrew/bin/node /Users/planner/roundhouse/scripts/hermes-decision.mjs "$@"
   ```

5. Configure SSH access using operator-managed keys and verified host keys, outside source control. Use a dedicated account with access only to the planning installation; restrict forwarding and unrelated remote commands where practical. Do not put keys, tokens or auth/config files in this repo. Disable shell banners on noninteractive stdout. Test transport with synthetic packets only after authorizing remote/model calls.
6. Prepare a separate, inactive Studio config copy. The existing command provider forwards stdin and appends `cleanup` or `cleanup-intent` for those modes:

   ```yaml
   decision:
     kind: command
     command: [ssh, -T, -o, BatchMode=yes, -o, StrictHostKeyChecking=yes, -o, ConnectTimeout=10, planner@imac.local, /Users/planner/bin/roundhouse-hermes]
   ```

   Local equivalent: `command: [node, /absolute/repo/scripts/hermes-decision.mjs]`, with the two model/provider variables supplied by the operator environment. Do not enable this in live Studio config as part of setup.

## Shadow and pilot

First run the adapter manually with synthetic or explicitly selected exported packets, saving proposed decisions separately. Do not feed shadow output into the live queue. Compare against existing Codex decisions: identity preservation, rationale, goals/non-goals, approval gate, verification IDs and slice order. Then pilot with a separate disposable state directory and inert execution commands; test Studio’s approval UI and revision guard. Activate production only as a separate human-authorized rollout, beginning with new selected ideas. Never reroute existing queue items as part of this integration. Switching the decision config back to Codex rolls back future planning; it does not undo already approved jobs. Cleanup uses the same global decision command when enabled, so validate both cleanup modes before any production pilot.

## Safety and troubleshooting

The adapter has no shell interpolation. It sends the complete packet as untrusted evidence via stdin, skips custom instructions/memory/plugins/MCP, and enables only the built-in `clarify` toolset, which has no shell, filesystem, network, scheduling or mutation tools. It instructs Hermes not to call tools; one turn bounds attempted tool use. This is a planning invocation, not an OS sandbox: Hermes itself may write its normal local session/auth-refresh bookkeeping. Verify the installed Hermes version’s toolset/isolation semantics before adoption; do not substitute `safe` (it includes network/image tools), an empty toolset (may enable defaults), or auto-approval flags.

Input and combined child stdout/stderr are limited to 256 KiB. Help times out at 10 seconds, inference at 90 seconds (inside Roundhouse’s 120-second command deadline); timed-out process groups are killed. Only a strictly schema-validated JSON object is printed. Markdown fences, logs mixed with JSON, unknown nested fields, omitted schema fields, provider failures and invalid confidence fail nonzero. Raw child diagnostics are discarded; the adapter emits a generic error on stderr so logs/keys cannot enter the decision stdout channel. No credentials are read by this adapter.

If help fails, repair Hermes separately under operator authority; the adapter never installs or repairs it. If authentication/model selection fails, check the existing authenticated provider and supported model directly on iMac; do not paste credentials into packets. If SSH fails, check paths, BatchMode authentication and host-key verification without weakening them. If output fails validation, inspect synthetic runs privately and choose a model that reliably returns strict JSON. Roundhouse already makes invalid cleanup decisions fall back to an operator question; triage and cleanup-intent failures remain errors. Test with `node --test test/hermes-decision.test.js` and `npm check` without any model/network calls.


## One-week Hermes-first trial (Oct 8–15, 2026)

Primary decisioning lives on the authenticated iMac. Studio's authoritative
`decision.kind: command` invokes it over SSH. When SSH is inaccessible
(exit 255), or the Hermes process/model transport cannot run (exit 75),
Studio calls Codex through the existing read-only decision interface.
No fallback occurs for invalid decision JSON, low planning confidence, or an
explicit Hermes planning block. The result reason records Codex fallback and
the failed transport code. No retried Hermes invocation is dispatched by
fallback, so each intake creates at most one accepted decision.

Configure **the installed Studio configuration**, not the portable repository
example, after code deployment and validation:

```yaml
decision:
  kind: command
  command: [/usr/bin/ssh, -T, -o, BatchMode=yes, -o, StrictHostKeyChecking=yes, -o, ConnectTimeout=10, ryngrn@192.168.4.59, /home/ryngrn/.local/bin/roundhouse-hermes-pilot]
  fallback:
    kind: codex
    bin: /Users/ryngrn/.local/bin/codex
```

If Hermes deems a complex multi-feature request insufficiently scoped, too
uncertain to plan (below 0.70 execution confidence), or reaches eight work
slices, it returns `Blocked` with `blocked_on: [hermes:planning_capacity]`.
Roundhouse retains the original Depot record and rationale but creates **zero**
execution jobs. These Hermes planning holds are excluded from the automatic
Unblocker cleanup pass so they are not mistaken for obsolete tasks.
A later explicit retry or new operator direction can ask Hermes to refine them.
Clearly scoped multi-slice plans instead enter Review for a guarded approval;
simple ideas can proceed under configured project policy.

At the end of the trial review: Hermes-first planning success, fraction held
for more Hermes work, unnecessary questions, Codex fallback count, planning
latency, manual rework and approved-plan quality. Reverting means setting
`decision.kind: codex` in the Studio config and safely restarting the service.
Changing provider affects future decisions only; do not replay active jobs.
