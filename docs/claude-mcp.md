# Claude conversation → Roundhouse Depot

Claude conversation clients use the same four MCP tools and authoritative workflow
state documented in [chatgpt-mcp.md](chatgpt-mcp.md). A Claude submission includes
an `origin` object:

```json
{
  "source": "claude",
  "actor": "stable-user-reference",
  "project_id": "optional-project-id",
  "thread_id": "stable-conversation-reference",
  "correlation_id": "stable-turn-reference"
}
```

`thread_id` plus `correlation_id` is the submission identity, so retrying the same
turn returns the original Depot item and changing its content is rejected. Roundhouse
stores source, actor, optional project, thread, and correlation with the immutable
intake. The project remains subject to configured classification and policy; request
content cannot choose runtime, verification, or shipping behavior.

Claude polls `get_needs_human` with `source`, `thread_id`, and optionally
`correlation_id`. It sends exactly the returned current question ID and revision to
`answer_question`, together with the same `origin`. Roundhouse rejects a stale
revision, an already answered question, or a mismatched conversation, records the
answer against the existing decision history, and re-evaluates without restarting
refinement. `get_work_status` accepts the same conversation filters and is a durable,
read-only projection; extra policy or workflow fields are rejected.
