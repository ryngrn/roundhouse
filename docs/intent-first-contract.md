# Intent-first Projects contract

This additive contract is the authoritative UI and relay shape for Roundhouse's intent-first Projects program. Existing item/job fields and projection schema version 2 remain compatible. New fields are nullable or empty for legacy records.

## Safety and authority model

Roundhouse preserves the submitted intake as immutable evidence in `item.raw_idea`. Editable understanding lives separately in the versioned `item.intent` object.

Broad work has two independent gates:

1. `confirm-intent` confirms product direction and the reviewable plan. It never creates jobs, starts execution, or calls the decision provider again.
2. Existing `approve` grants execution authority for the current Review revision. Only this gate can change a confirmed broad intent to `execution_approved` and create Ready jobs.

An answer to an intent question records clarification only. It does not re-decide, approve, or create work. At most one intent question is open at a time. Roundhouse uses the existing `Depot -> Decision -> Needs Clarification` states; `discovering` is intent metadata, not a workflow-engine state.

Tactical work uses `intent.status = "tactical_fast_lane"` and retains the existing readiness and policy behavior. Broad classification is explicit when `metadata.intent_scope = "broad"`; otherwise the conservative deterministic classifier requires both long-form strategic and multi-part signals. `metadata.intent_scope = "tactical"` is an explicit fast-lane override.

No research proposal or monitoring experiment dispatches external action. Public posting, spending, and permission changes require a separate approval outside these methods.

## Canonical item shape

`itemView` and every dashboard item/job projection include:

```json
{
  "project_id": "project-id",
  "project_name": "Project name",
  "raw_idea": {
    "id": "raw-idea:<digest>",
    "captured_at": "ISO-8601",
    "source": "web",
    "actor": "local-user",
    "input_digest": "digest",
    "text": "verbatim submitted text",
    "context": {},
    "conversation": {},
    "attachments": []
  },
  "intent": {
    "status": "discovering | ready_for_confirmation | confirmed | execution_approved | tactical_fast_lane",
    "summary": "editable confirmed-intent summary",
    "fields": {},
    "confirmed_fields": ["desired_outcome"],
    "unresolved_questions": [{ "id": "question-id", "field": "desired_outcome", "prompt": "..." }],
    "completion_type": "Done when shipped | Done when outcome reached",
    "original_context_reference": "raw-idea:<digest>",
    "discovery_non_executable": true,
    "feature_id": "feature-id",
    "goal_ids": ["goal-id"],
    "version": 2,
    "planning_confirmation": { "actor": "...", "item_revision": 4, "at": "ISO-8601" },
    "execution_approval": { "actor": "...", "item_revision": 6, "at": "ISO-8601" },
    "work_slices": [{
      "id": "item-id:slice:1",
      "sequence": 1,
      "title": "...",
      "outcome": "...",
      "acceptance_criteria": [],
      "status": "planned | ready | shipped",
      "work_item_id": "item-id",
      "job_id": "item-id-1"
    }]
  }
}
```

`input.text`, `input.context`, and `input.conversation` are never rewritten by discovery or confirmation. `intent.versions` is persisted internally; the canonical projection exposes the current version and gate records.

## Canonical project hierarchy

`overview.projects` remains an object keyed by project ID. Each value includes the project `id`, `name`, `revision`, existing execution/project policy fields, and these arrays:

```json
{
  "goals": [{
    "id": "goal-id",
    "title": "...",
    "description": "prose goal",
    "why": "...",
    "success_criteria": "optional prose",
    "measurable_target": { "metric": "conversion_rate", "value": 0.1 },
    "status": "Active | Achieved",
    "evidence": [{ "source": "analytics-export", "reference": "snapshot:123" }],
    "evaluations": [],
    "progress": { "result": "no_traffic | poor_conversion | data_unavailable | progressing | achieved_target", "metrics": {}, "evaluated_at": "ISO-8601" },
    "proposed_options": ["experiment-id"],
    "next_evaluation_at": "ISO-8601 or null"
  }],
  "features": [{
    "id": "feature-id",
    "title": "...",
    "description": "...",
    "why": "...",
    "success_criteria": "optional prose",
    "completion_type": "Done when shipped | Done when outcome reached",
    "goal_ids": ["goal-id"],
    "status": "Planned | Shipped; outcome pending | Done | Achieved",
    "evidence": [],
    "progress": null,
    "work_item_ids": ["stable-item-id"],
    "proposed_options": ["research-id"]
  }],
  "research_tasks": []
}
```

Feature retries do not create new item or feature identities. A feature contains unique stable `work_item_ids`; sequential slices have stable slice IDs, map to deterministic job IDs, and execution retries remain entries in the existing job `attempts` array.

Shipment completes a `Done when shipped` feature. Shipment only changes a `Done when outcome reached` feature to `Shipped; outcome pending`; only an explicit evaluation with cited evidence meeting the measurable target changes it to `Achieved`.

## Mutating HTTP actions

All writes use existing loopback Origin protection. Revision fields are required compare-and-set guards.

- `POST /api/projects/:projectId/goals`
  - body: `{ "expected_project_revision": 1, "goal": { "id?", "title", "description", "why", "success_criteria?", "measurable_target?" } }`
- `POST /api/projects/:projectId/features`
  - body: `{ "expected_project_revision": 2, "feature": { "id?", "title", "description", "why", "success_criteria?", "completion_type", "goal_ids": [] } }`
- `POST /api/items/:itemId/intent-answer`
  - body: `{ "expected_item_revision", "question_id", "expected_question_revision", "answer", "fields": {}, "next_question?": { "field", "prompt" } }`
  - response includes `reevaluated: false`; no jobs are created.
- `POST /api/items/:itemId/confirm-intent`
  - body: `{ "expected_item_revision", "fields?": {}, "feature_id?", "goal_ids?": [] }`
  - response includes `planning_confirmed: true`, `execution_approved: false`; no jobs are created.
- `POST /api/items/:itemId/approve`
  - existing body: `{ "expected_revision" }`
  - this is execution approval. For broad work it is rejected until intent is confirmed.
- `POST /api/projects/:projectId/research`
  - body: `{ "expected_project_revision", "feature_id?", "unknown", "options": [{ "id?", "title", "description?", "pros": [], "cons": [] }], "recommendation", "citations": [{ "source", "reference", "note?" }], "external_action?": true }`
  - returns `dispatched: false`. External-action proposals have status `approval_required`.
- `POST /api/projects/:projectId/goals/:goalId/evaluations`
  - body: `{ "expected_project_revision", "evidence": [{ "source", "reference" }], "metrics": {}, "data_status?": "available | unavailable", "hypotheses?": [], "experiments?": [], "next_evaluation_at?" }`
  - every experiment is stored as `status: "proposed", decision_required: true`.

The local state file and PostgreSQL adapter both persist these fields through their existing authoritative JSON payload boundary. Aiven receives only the canonical dashboard projection. There is no new service or polling loop; evaluation is an explicit run, and `next_evaluation_at` is a durable scheduling hook for existing safe wake/scheduling infrastructure.
