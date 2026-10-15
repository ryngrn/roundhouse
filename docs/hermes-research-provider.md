# Hermes research worker (opt-in)

Run `scripts/hermes-research-provider.mjs` on a host with Hermes and an explicitly configured model alias. The adapter reads one Roundhouse command-provider dispatch packet from stdin, invokes Hermes in safe mode, and returns one JSON object with its draft report on stdout. It never claims research was verified merely because the model produced an answer.

## Studio validation, 2026-10-15

Hermes v0.22.2 installed in `~/.hermes`; local alias `roundhouse-local` targets the existing Ollama `qwen3-coder:30b` at `127.0.0.1:11434/v1`. A bounded smoke test passed. The model generated an unverified citation, so **research source verification remains mandatory** before accepting findings.

## Opt-in provider declaration

On a worker running this repository, add to the *worker-local* Roundhouse manifest after checking local paths and project policy:

```yaml
execution:
  capacity: 1
  capabilities: [local, research, artifact]
  providers:
    - id: local-project
      kind: project
      capabilities: [local]
    - id: hermes-studio
      kind: command
      capabilities: [research, artifact]
      command: [node, /absolute/path/to/roundhouse/scripts/hermes-research-provider.mjs]
```

Never merge this example into a live manifest blindly. Register `research` only when the machine can run the model, when its required source tools are available, and when downstream verification exists. Model output is unverified by default.

This is a **local command-provider adapter**, not a distributed worker registry. The current dispatcher selects from a single process's provider config; it does not yet distribute dispatch across online machines. The cloud-control-plane worker registration and heartbeat work must precede multi-machine routing. Do not use a stale Studio heartbeat to claim the iMac can take work; avoid replay of uncertain attempts.

Environment: `ROUNDHOUSE_HERMES_MODEL` optionally overrides the `roundhouse-local` alias; `ROUNDHOUSE_HERMES_BIN` optionally overrides the Hermes executable. Never store model credentials in Roundhouse manifests.
