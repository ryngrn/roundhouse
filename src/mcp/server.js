import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const nonblank = (maximum) => z.string().min(1).max(maximum).refine((value) => value.trim().length > 0, "Must contain non-whitespace text.");
const filterSchema = {
  project_id: nonblank(200).optional().describe("Limit results to one Roundhouse project ID."),
  item_id: nonblank(200).optional().describe("Limit results to one durable Depot item ID."),
};

const jobSchema = z.object({
  id: z.string(), title: z.string(), state: z.string(), reason: z.string().nullable(), attempts: z.number(), shipping: z.unknown().nullable(),
});
const itemSchema = z.object({
  id: z.string(), state: z.string(), revision: z.number(), project: z.string().nullable(), summary: z.string(),
  reason: z.string().nullable(), question: z.string().nullable(), question_id: z.string().nullable(), question_revision: z.number().nullable(),
  outcome: z.string().nullable(),
  evidence: z.object({
    checks: z.array(z.object({ id: z.string(), passed: z.boolean(), exit_code: z.number().optional() })),
    deliveries: z.array(z.object({
      job_id: z.string(), commit: z.string().nullable(), branch: z.string().nullable(), pushed: z.boolean(),
      deployment: z.unknown().nullable(), timestamp: z.string().nullable(),
    })),
  }),
  jobs: z.array(jobSchema),
});
const questionSchema = z.object({
  id: z.string(), decision_id: z.string(), revision: z.number(), kind: z.enum(["clarification", "review"]), prompt: z.string(),
  item_id: z.string(), item_revision: z.number(), project: z.string().nullable(), state: z.string(),
});

function result(structuredContent, text) {
  return { structuredContent, content: [{ type: "text", text }] };
}

export function createRoundhouseMcpServer(service) {
  const server = new McpServer(
    { name: "roundhouse-depot", version: "0.1.0" },
    { instructions: "Capture intent verbatim. Project hints are non-authoritative. Roundhouse owns inference, questions, planning, priority, readiness, and execution policy. Use answer_question only with the current durable question revision.", maxToolInputElements: 1_000 },
  );

  server.registerTool("add_to_depot", {
    title: "Add to Roundhouse Depot",
    description: "Durably capture the user's original intent and relevant conversation context in Roundhouse. Use project_hint only when the user supplied a likely project; Roundhouse performs project inference and planning.",
    inputSchema: {
      content: nonblank(100_000).describe("The original user intent to preserve verbatim, in ordinary language."),
      project_hint: nonblank(500).optional().describe("A non-authoritative project name or ID hint."),
      context: z.union([z.string().max(100_000), z.record(z.string(), z.unknown())]).optional().describe("Relevant conversational context, kept separate from the original intent."),
      attachments: z.array(z.object({
        uri: z.string().url().max(2_048),
        name: z.string().min(1).max(500).optional(),
        media_type: z.string().min(1).max(200).optional(),
      }).strict()).max(20).optional().describe("References to attachments already reachable by Roundhouse; file upload is not provided by this tool."),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Channel-neutral correlation metadata; do not place secrets here."),
      idempotency_key: nonblank(500).optional().describe("Stable caller key for safe retry deduplication."),
    },
    outputSchema: { item: itemSchema, durable: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    const value = service.addToDepot(input, { source: "chatgpt:mcp", actor: "chatgpt-user" });
    return result(value, `Saved item ${value.item.id} in Roundhouse: ${value.item.state}.`);
  });

  server.registerTool("get_needs_human", {
    title: "Get Roundhouse questions",
    description: "List current material questions or review decisions that Roundhouse is waiting for a human to answer. Returns durable IDs and revision guards for answer_question.",
    inputSchema: filterSchema,
    outputSchema: { questions: z.array(questionSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (filters) => {
    const value = service.getNeedsHuman(filters);
    return result(value, value.questions.length ? `Roundhouse is waiting on ${value.questions.length} question(s).` : "Nothing in Roundhouse is waiting on you.");
  });

  server.registerTool("answer_question", {
    title: "Answer a Roundhouse question",
    description: "Record a human answer against a current durable Roundhouse question or decision ID, then immediately re-evaluate project inference and readiness. Reusing an answered or stale revision is rejected.",
    inputSchema: {
      id: nonblank(200).describe("The question_id or decision_id returned by get_needs_human."),
      answer: nonblank(100_000).describe("The user's answer in their own words, preserved verbatim."),
      expected_revision: z.number().int().positive().describe("The current question revision returned by get_needs_human."),
    },
    outputSchema: { item: itemSchema, answer_recorded: z.boolean(), reevaluated: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    const value = await service.answerQuestion(input);
    const suffix = value.item.question ? ` Waiting on: ${value.item.question}` : "";
    return result(value, `Answer saved; item ${value.item.id} is now ${value.item.state}.${suffix}`);
  });

  server.registerTool("get_work_status", {
    title: "Get Roundhouse work status",
    description: "Get compact durable status for Roundhouse Depot items and their work. Use this for progress or outcome questions; it does not change or advance work.",
    inputSchema: filterSchema,
    outputSchema: { items: z.array(itemSchema), projects: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (filters) => {
    const value = service.getWorkStatus(filters);
    return result(value, value.items.length ? `Found ${value.items.length} Roundhouse item(s).` : "No matching Roundhouse work found.");
  });

  return server;
}
