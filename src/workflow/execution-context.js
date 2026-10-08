export function requestContextFromItem(item) {
  if (!item?.input || typeof item.input.text !== "string") return null;
  const conversation = item.input.conversation;
  return structuredClone({
    original_request: item.input.text,
    ...(item.input.context === undefined ? {} : { supplied_context: item.input.context }),
    ...(conversation === undefined ? {} : {
      conversation: {
        link: conversation.link,
        snapshot: conversation.snapshot,
        ...(conversation.live_context === undefined ? {} : { live_context: conversation.live_context }),
      },
    }),
    operator_clarifications: (item.clarifications ?? []).map(({ text, actor, at, question_id, decision_key }) => ({
      text, actor, at, ...(question_id ? { question_id } : {}), ...(decision_key ? { decision_key } : {}),
    })),
  });
}

export function jobWithCurrentRequestContext(data, job) {
  const current = requestContextFromItem(data.items?.[job.parent_id]);
  return current ? { ...job, request_context: current } : job;
}

export function executionPacket(job, { previousFailure = null, run } = {}) {
  const { agent_profile: _agentProfile, ...projectContext } = job.project_context ?? {};
  return {
    request_context: job.request_context ?? null,
    work: job.work,
    project_context: projectContext,
    previous_failure: previousFailure,
    ...(run === undefined ? {} : { run }),
  };
}

export function formatExecutionBrief(packet) {
  const request = packet.request_context ?? {};
  const sections = [
    "Execution context is ordered by authority. Preserve the user's original request as the primary statement of intent. Use the conversation transcript and later operator clarifications to recover nuance and resolve ambiguity; later explicit user corrections supersede earlier conflicting statements. The assigned job slice narrows what to do in this run, but must not replace or garble the original request. Project policy and the safety constraints above remain binding.",
    "\n## Original request (verbatim)\n" + (request.original_request ?? "Original request unavailable."),
  ];
  if (request.conversation) sections.push("\n## Conversation transcript and live thread context\n" + JSON.stringify(request.conversation, null, 2));
  if (request.supplied_context !== undefined) sections.push("\n## Additional supplied context\n" + JSON.stringify(request.supplied_context, null, 2));
  if (request.operator_clarifications?.length) sections.push("\n## Later operator clarifications\n" + JSON.stringify(request.operator_clarifications, null, 2));
  sections.push("\n## Assigned job slice\n" + JSON.stringify(packet.work, null, 2));
  sections.push("\n## Project execution context\n" + JSON.stringify(packet.project_context, null, 2));
  if (packet.previous_failure) sections.push("\n## Previous failed attempt evidence\n" + JSON.stringify(packet.previous_failure, null, 2));
  if (packet.run) sections.push("\n## Run identity\n" + JSON.stringify(packet.run, null, 2));
  return sections.join("\n");
}
