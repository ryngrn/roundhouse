# Roundhouse

Roundhouse is a thin, generic orchestration layer between approved work and a
replaceable execution provider. This first vertical slice connects a Notion item
delivered by ChatGPT to a local Codex CLI process reached through Remote Desktop
Commander.

## What this slice guarantees

- Only a Notion item whose status is exactly `Ready` can execute.
- `Project` is resolved exclusively from YAML configuration.
- An unmapped project, missing repository, non-Git directory, or dirty worktree
  produces a clear `Blocked` lifecycle event.
- Codex runs non-interactively, performs checks, and must create a local commit.
- `Review` is requested only when a new commit exists and the worktree is clean.
- No code path marks an item `Done`, pushes a commit, opens a PR, or deploys.
- Per-item locks prevent duplicate local dispatch.
- Prompts, JSONL traces, stderr, and results are retained under the configured
  state directory rather than written into target repositories.

## Setup

```sh
npm install
npm link
cp config/projects.example.yaml ~/.config/roundhouse/projects.yaml
```

Edit `~/.config/roundhouse/projects.yaml` to add or change projects. No
orchestration code changes are required.

## Usage

```sh
roundhouse dispatch --item /absolute/path/to/notion-item.json --dry-run
roundhouse dispatch --item /absolute/path/to/notion-item.json
```

See [docs/chatgpt-rdc-bridge.md](docs/chatgpt-rdc-bridge.md) for the connector
workflow and lifecycle-event contract.
