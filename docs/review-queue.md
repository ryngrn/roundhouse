# Needs Review: unified attention contract

Project remains the top-level container, with optional Goals and a universal Depot intake.

Needs Review is a cross-cutting, computed human-attention queue. It is not a
replacement for the stored execution state, nor authority to execute or retry.

Stored Blocked items, Needs Clarification and Review items require attention.
Ready items with a nonrecoverable dispatch hold (blocked/missing prerequisite,
invalid verification, policy mismatch) also require review. Ready items merely
waiting on a normal Ready predecessor do not request human intervention.
Depot items waiting for automatic classification do not request human intervention.

Projection fields: review_required, review_kind, review_reason, needs_you (legacy
compatibility). The UI uses one membership predicate to drive its Needs Review
card, attention list, and Inbox filter. Raw stored states remain available as
distinct status chips with distinct icon/color and clear reasons. The Results
page can still report raw historical blocked outcomes.

The detail panel supports one active clarification or revision-checked
blocker notes and repair planning. Repair creates a separate Depot request.
Neither adding a note nor planning a repair directly replays the failed job,
grants authority, or changes shipping policy.

No fabricated metrics, no new polling, and no protected-branch merges.
