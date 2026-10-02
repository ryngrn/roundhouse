# Notion Depot archive and one-time cutover

Roundhouse is the authoritative operational system for Depot intake, projects,
priorities, workflow state, Needs You, execution, verification, shipping, and
outcomes. The historical Notion **Roundhouse Depot** was a prototype and is now an
archive/reference only. Roundhouse never polls it, writes status back to it, or
uses a Notion value as execution authority.

## One-time import

Export the prototype rows as JSON, then run:

```sh
roundhouse migrate notion-depot /absolute/path/to/export.json
```

The installed Studio defaults are
`~/Library/Application Support/Roundhouse/state` and `projects.yaml` in the parent
directory. Tests and alternate installations can pass `--state-dir` and
`--config` explicitly.

The export can be an array or an object containing `rows`, `pages`, `records`,
`items`, or `results`. Each record needs a Notion page URL or source ID. The
importer understands plain exported values and common Notion API property values.
It retains the legacy Roundhouse ID, raw intake, brief, outcome, acceptance
criteria, decisions, status/workflow, delivery summary, timestamps, priority,
project label, and the other prototype fields.

Completed records become terminal `Imported History`. Unfinished records become
non-executable `Imported Pending` and require explicit Roundhouse re-evaluation:

```sh
roundhouse depot reevaluate-import \
  --state-dir "/absolute/path/to/state" \
  --config "/absolute/path/to/projects.yaml" \
  --id ITEM_ID --revision REVISION --actor OPERATOR
```

Answering an imported Needs Decisions prompt through the normal Needs You API is
also an explicit re-evaluation. Import itself never creates a job, calls the
decision provider, or wakes the worker.

Unknown projects are retained as non-executable project candidates. Exact Notion
source identity and exact native item/job IDs are used for reconciliation; text
similarity is deliberately not used. Re-running identical export bytes is a
state-level no-op. A later changed source record is reported as a conflict and
does not overwrite native or already imported history.

`state.json` records `system_metadata.notion_depot_cutover`, including completion
time, archive-only mode, export SHA-256 digest/count, and row results. The command
prints totals for imported history, imported pending, reconciled, already
imported, conflicts, and errors.
