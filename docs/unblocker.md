# Unblocker — intent-aware cleanup

Unblocker is a control-plane agent that keeps useful work moving without inventing intent. It evaluates only work in **Blocked** or **Needs Clarification**. Ready, executing, verification, review, rework, and shipped work are outside cleanup scope.

At each worker wake, Unblocker reads the preserved request, immutable conversation snapshot, optional live conversation reference, decisions, history, attempt evidence, project policy, and dependency graph. It selects one cleanup candidate and returns one of four structured actions: delete, repurpose, ask, or keep.

## Confidence gate

Delete and repurpose require confidence of at least 0.70. Below that threshold Unblocker pauses the item and asks one concise contextual question. The dashboard presents exactly two proposed answers plus a third **Take my own path** choice with free-form input. The answer is revision-guarded and returned to the worker as an `issue_resolution` command.

## Delete and dependency handling

Delete permanently removes the work instead of changing its state. Roundhouse retains only a brief tombstone containing the deleted identity, title, timestamp, reason, and evidence references. The original request is not copied into the tombstone.

If other work depends on a deleted prerequisite, Unblocker evaluates whether the remaining intent is still useful. A repurposed dependent keeps its ID and history, removes the dead dependency, records active scope, and records removed scope for a visible crossed-out presentation. Unstarted repurposed work returns through normal readiness and safety gates; it is never declared successful or allowed to bypass approvals.

## Conversation context

Intake may include a `conversation` object with:

- `snapshot`: immutable transcript text captured with the request
- `link`: stable live conversation URL or identifier
- `live_context`: optional newer context supplied by an authorized connector

The snapshot persists even when the live link becomes unavailable. Roundhouse stores and projects this metadata but does not scrape private chat transcripts; the authorized intake client or connector must supply it.

## Safety and operation

Operator stops, approval gates, and execution safety policies still outrank cleanup. Unblocker never marks a job Shipped, fabricates evidence, grants approval, or replays side effects. Its delete/repurpose authority is limited to Blocked and Needs Clarification records.

Worker status exposes the last run, result, and error. Cleanup is intentionally bounded to one candidate per wake so each mutation is durable and auditable before another candidate is considered. Repeated worker wakes can drain eligible backlog without releasing the whole queue at once.

Run one local pass with:

```sh
node src/cli.js depot unblock --state-dir "$HOME/Library/Application Support/Roundhouse/state" --config "$HOME/Library/Application Support/Roundhouse/projects.yaml"
```

Tests cover permanent deletion and tombstones, dependent identity preservation, crossed-out removed scope, the 70% question gate, transcript persistence, remote answers, and the strict Blocked/Needs Clarification boundary.
