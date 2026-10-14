# One review decision per item

Roundhouse's primary human review contract is **Approve / Change / Retire**.
It simplifies the presentation and routing, not the revision, dependency,
verification, or shipping safety rules.

## Server-owned actions

The reviewAction service accepts a current item ID, revision, and one choice:

- **Approve:** for an actual Review item, delegate to the guarded approval.
  For broad intent ready for confirmation, confirm the plan only without
  execution authority. Waiting cleanup issues accept only a named,
  non-destructive option. No choice grants production deployment.
- **Change:** capture a short new direction and re-evaluate one open question
  or an unstarted plan. Failed execution attempts are never replayed.
- **Retire:** archive an unstarted standalone item with its history intact.
  Previously attempted jobs use the existing verified cleanup option;
  requesting removal is not itself proof that the job has been removed.
  Dependencies and active work are checked before any mutation.

All choices use the current revision and fail closed on stale state, policy
changes, missing authority, live execution, or unsafe dependencies.

## Authenticated remote dashboard

The hosted dashboard queues a review_action command; the Studio processes
it and durably records accepted or failed. A bounded receipt endpoint returns
only command status, accepted outcome, and error; never the private payload.
The UI advances only after confirmed authoritative success, not after queue
insertion. It persists only opaque IDs and revision for pending receipts, so
reloading does not offer a duplicate click.

The brief and three buttons appear together. History, original intent and
technical details are behind the collapsed View details section.

## Human review counts

Human review counts include real approval and pending consequential questions,
not technical blockers or dependency waits. An already-answered cleanup issue
does not hide a separate pending Review approval.

## Release order

Deploy core before dashboard so the new remote command has a handler.
Existing legacy routes remain for compatibility. Full core, hosted API and
320-pixel UI regression tests must pass before a production release.
