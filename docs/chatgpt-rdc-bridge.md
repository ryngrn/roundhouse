# ChatGPT + Notion + Remote Desktop Commander bridge

This bridge keeps provider-specific work outside the Roundhouse core:

- ChatGPT's Notion connector reads and updates the Roundhouse Inbox.
- Remote Desktop Commander transports commands and files to the selected machine.
- `roundhouse dispatch` resolves the item's `Project` through YAML configuration.
- Codex CLI implements, checks, and commits the work in the mapped repository.

## Status contract

Only `Ready` is executable. The bridge applies each `notion.status_requested`
JSONL event emitted by the CLI to the same Notion page:

1. `Running` immediately after validation, repository resolution, and lock acquisition.
2. `Review` only after Codex exits successfully, creates a new local commit, and leaves a clean worktree.
3. `Blocked` when mapping, repository validation, Codex execution, tests, commit verification, or another required step fails.

The bridge never writes `Done`.

## Item payload

Write the fetched Notion item to a temporary JSON file on the device. The payload
may contain flat MCP properties or REST-style Notion property objects. A minimal
payload is:

```json
{
  "url": "https://app.notion.com/p/<page-id>",
  "properties": {
    "Item": "Implement the approved slice",
    "Project": "Inclusion",
    "Status": "Ready",
    "Normalized Brief": "...",
    "Outcome": "...",
    "Acceptance Criteria": "..."
  },
  "content": "Optional body text from the Notion page"
}
```

## RDC invocation

First validate without executing:

```sh
roundhouse dispatch --item /tmp/roundhouse-item.json --dry-run
```

Then execute and monitor JSONL output:

```sh
roundhouse dispatch --item /tmp/roundhouse-item.json
```

The ChatGPT bridge should update Notion as soon as each lifecycle event appears,
then report the commit SHA, commit subject, Codex summary, and run-artifact path.
Do not dispatch a second item until the first process reaches a terminal event.

## Selecting work

Query the Roundhouse Inbox data source for `Status = Ready`. Select work according
to the requested policy (or priority then creation time when no policy is given),
fetch the complete page, and preserve the original page URL in the item payload.

Project names are never routed in bridge logic. The bridge passes `Project`
through unchanged; `~/.config/roundhouse/projects.yaml` is the sole mapping source.
