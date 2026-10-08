# Mixed-provider operation

Roundhouse selects providers independently at three boundaries: `decision` turns
Depot input into structured work, `conversation` carries bounded human interaction,
and each project's `executor` implements approved work. Codex and Claude Code
support all three capabilities. A command provider supports decision and execution,
but cannot be configured for conversation. Roundhouse remains the control plane:
providers cannot claim work, approve it, change verification, or ship it.

## Selection and migration defaults

Existing manifests remain Codex-compatible. Omitting `decision` selects
`{ kind: codex, bin: codex }`; omitting a project executor does the same. Explicit
`kind: claude` settings keep their existing behavior. The boundaries can be mixed,
so a Claude decision provider may route to a Codex executor, or the reverse. Provider
selection is configuration and policy, not request content. An unsupported kind,
capability declaration, runtime, Claude tool rule, or `fallback` setting is rejected
when configuration loads.

The optional conversation provider is interaction-only. Claude clients submit via
`add_to_depot`, poll `get_needs_human`, answer the exact current question and
revision with `answer_question`, and read durable state with `get_work_status`.
The stable thread and correlation identifiers preserve intake idempotency and
conversation parity with other MCP clients. Clarification re-runs the configured
decision provider with prior answers; it does not grant the conversation client
workflow authority. See [the Claude MCP contract](claude-mcp.md) for the origin and
filter fields.

## Probes, evidence, and failures

Status and durable attempt records expose only allowlisted provider metadata:
provider ID, kind, declared and required capabilities, probe results, selected and
invoked provider, invocation time, run ID, and provider transitions. Executable
arguments, credentials, private reasoning, and raw model event streams are excluded.
A capability probe records every considered provider and its missing capabilities;
selection chooses one provider that satisfies the complete requirement rather than
composing partial providers.

Provider failures are categorized as `quota`, `authentication`, or `availability`.
A category alone never proves replay safety. Fallback is eligible only when the
provider explicitly reports `safe_to_retry: true`, `replay_safe: true`, or an
`action_status` of `none`, `not_started`, or `pre_action`. Roundhouse closes the
failed attempt, records its evidence, excludes that provider, and selects a different
configured compatible provider for a new attempt. It never changes provider inside
an active attempt, and this operational fallback does not consume the work-repair
budget.

An action reported as started, uncertain, unknown, or possibly completed is never
replayed. Roundhouse blocks it for reconciliation. If no compatible provider remains,
the job is Blocked with the unavailable dependency or capability. Decision and
conversation providers never switch implicitly; their failures remain visible for
operator recovery.

## Local, Herdr, and AXI boundaries

`runtime: local` is the migration default. `runtime: herdr` supports a shared
Roundhouse worktree or `machine_local` execution in an absolute repository path on
the selected fleet machine. Herdr is probed before dispatch. Claude-backed Herdr
work additionally requires the machine and agent to advertise a usable Claude
installation, compatible version, authentication, quota, availability, and an idle
agent. Probe failures retain their precise phase and remote identity. Herdr never
falls back to local execution, and machine-local completion requires correlated
commit, branch, configured-check, and push evidence from the remote agent.

Model-agent prompts prefer GitHub and browser AXI interfaces where supported because
they reduce tool traffic. Existing Git/GitHub CLI and Playwright/browser paths are
bounded tool-level fallbacks when AXI is absent, unauthenticated, or lacks the needed
operation. AXI preference applies to local and both Herdr workspace modes without a
project setting. It does not apply to operator-owned command providers and never
changes the chosen provider, runtime, approval, verification, or delivery authority.

Deterministic unit and end-to-end tests cover legacy Codex defaults and Codex-only
delivery, Claude-only delivery and conversation intake/clarification/status, mixed
decision/execution routing, provider metadata and capability selection, Herdr Claude
preflight and both workspace modes, quota/authentication failures, safe new-attempt
fallback, and refusal to replay uncertain external actions.
