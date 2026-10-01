# Notion Depot control surface

The existing ChatGPT Notion connector can continue to fetch work and show results.
Remote Desktop Commander can transport files/commands where available. Neither
connector is embedded into the generic workflow engine.

## Schema migration

The existing Roundhouse Inbox database/data source was renamed **Roundhouse Depot**.
Its ID is unchanged. Existing planning properties and records are preserved.
Three additive properties support the autonomous workflow:

- `Workflow State`: Depot, Decision, Needs Clarification, Ready, Executing,
  Verification, Rework, Review, Blocked, Shipped.
- `Roundhouse Job ID`: text containing the local item/job identity.
- `Delivery Summary`: text with delivery refs and verification summary.

The old `Status` select and its values remain for historical planning and the
legacy adapter. Do not infer execution approval from either Status or Agent Ready.
For new engine-managed work, use Workflow State. Old planning records are not
automatically executed or bulk reclassified by this migration.

## Submit a fetched page

Export a fetched page into JSON with a source `url`, `properties`, and optional
`content`. Flat MCP and REST rich-text/select properties are accepted:

```json
{
  "url": "https://app.notion.com/p/PAGE_ID",
  "properties": {
    "Item": "Improve the homepage",
    "Project": "Example",
    "Raw Intake": "The homepage explanation is confusing; make it clearer.",
    "Outcome": "Visitors understand the product.",
    "Acceptance Criteria": "Project-specific checks and approval policy apply."
  }
}
```

```sh
node src/cli.js depot submit --state-dir STATE --config CONFIG --notion page.json
node src/cli.js depot run --state-dir STATE --config CONFIG
node src/cli.js depot outbox --state-dir STATE
```

The page source URL is the default idempotency key. Reimporting unchanged content
does not create a duplicate; changed content under the same key is rejected. Use
clarification for an existing pending request or an explicit new key for new work.
The original Raw Intake is preferred, then Normalized Brief, then Item title.
Other supplied fields become decision context. Project names must map uniquely to
configured IDs; unmapped names fail visibly.

## Returning results

The persistent outbox contains source URLs and transition events. Its `current`
projection contains aggregate item state and per-job delivery evidence. The bridge
should use that current projection, not blindly replay an old event, when updating
Workflow State. For decomposed requests, the parent becomes Shipped only when all
its jobs have shipped. Populate Roundhouse Job ID and Delivery Summary using the
returned IDs, branch, commit and verification evidence. Surface the decision's
question only for Needs Clarification or Review. Record human answers through
`depot clarify` or revision-bound `depot approve`, then run again.

This preserves the existing connector-driven architecture: importing/exporting is
an explicit bridge action. There is no unattended Notion polling service or stored
Notion credential in the engine. CLI input works without Notion. Local workflow
state is authoritative; a connector update failure does not rerun shipped work.

## Legacy dispatch

The older `roundhouse dispatch --item page.json` path is retained for compatibility.
It accepts only Status Ready, resolves a repository from the legacy YAML mapping,
and asks the bridge for Running, Review, or Blocked. Its Review is a human delivery
approval gate because that adapter neither verifies through the new policy engine
nor pushes. It never marks Done. It should not be used for new autonomous work.
