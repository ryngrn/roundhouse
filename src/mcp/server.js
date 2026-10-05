import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const nonblank = (maximum) => z.string().min(1).max(maximum).refine((value) => value.trim().length > 0, "Must contain non-whitespace text.");
const filterShape = {
  project_id: nonblank(200).optional().describe("Limit results to one Roundhouse project ID."),
  item_id: nonblank(200).optional().describe("Limit results to one durable Depot item ID."),
};
const filterSchema = z.object(filterShape).strict();

const jobSchema = z.object({
  id: z.string(), title: z.string(), state: z.string(), reason: z.string().nullable(), attempts: z.number(), agent_role: z.string(), shipping: z.unknown().nullable(),
  job_id: z.string(), item_id: z.string(), project: z.string(), project_id: z.string(), active: z.boolean(), display_state: z.string(), runtime: z.string(),
  machine: z.string().nullable(), agent: z.string().nullable(), workspace_mode: z.string().nullable(), working_directory: z.string().nullable(),
  remote_run_id: z.union([z.string(), z.number()]).nullable(), remote_execution: z.unknown().nullable(), owning_node: z.string().nullable(),
  latest_run: z.unknown().nullable(), latest_failure: z.string().nullable(), reconciliation: z.unknown().nullable(),
  allocation: z.unknown().nullable(), allocation_history: z.array(z.unknown()),
  eligibility: z.unknown().nullable(), recurrence: z.unknown().nullable(), occurrence_key: z.string().nullable(),
  action_policy: z.unknown().nullable(), human_task: z.unknown().nullable(),
}).passthrough();
const activeJobSchema = z.object({
  id: z.string(), job_id: z.string(), item_id: z.string(), project: z.string(), project_id: z.string(), title: z.string(), state: z.string(),
  active: z.literal(true), display_state: z.string(), runtime: z.string(), machine: z.string().nullable(), agent: z.string().nullable(),
  workspace_mode: z.string().nullable(), working_directory: z.string().nullable(), remote_run_id: z.union([z.string(), z.number()]).nullable(),
  remote_execution: z.unknown().nullable(), owning_node: z.string().nullable(),
}).passthrough();
const completionReportSchema = z.object({
  summary: z.string(), design_decisions: z.array(z.string()),
  evidence: z.array(z.object({ id: z.string(), passed: z.boolean(), summary: z.string(), artifacts: z.array(z.string()) })),
});
const itemSchema = z.object({
  id: z.string(), state: z.string(), revision: z.number(), project: z.string().nullable(), summary: z.string(),
  project_candidate: z.unknown().nullable(), priority: z.string().nullable(),
  reason: z.string().nullable(), question: z.string().nullable(), question_id: z.string().nullable(), question_revision: z.number().nullable(),
  outcome: z.string().nullable(),
  imported: z.boolean(), provenance: z.unknown().nullable(), legacy: z.unknown().nullable(),
  requires_reevaluation: z.boolean(), execution_eligible: z.boolean(),
  execution_ineligibility_reasons: z.array(z.object({ code: z.string(), message: z.string(), missing: z.array(z.string()).optional() })),
  created_at: z.string().nullable(), updated_at: z.string().nullable(),
  evidence: z.object({
    checks: z.array(z.object({ id: z.string(), passed: z.boolean(), exit_code: z.number().optional(), source: z.string(), summary: z.string().optional(), artifacts: z.array(z.string()).optional() })),
    deliveries: z.array(z.object({
      job_id: z.string(), provider: z.string().nullable(), commit: z.string().nullable(), branch: z.string().nullable(), pushed: z.boolean(),
      version: z.unknown().nullable(), reference: z.string().nullable(), outputs: z.array(z.unknown()),
      result: z.unknown().nullable(), provenance: z.unknown().nullable(), deployment: z.unknown().nullable(), timestamp: z.string().nullable(),
    })),
    completion_reports: z.array(completionReportSchema),
    completion_results: z.array(z.unknown()),
    outputs: z.array(z.unknown()),
  }),
  jobs: z.array(jobSchema),
}).passthrough();
const questionSchema = z.object({
  id: z.string(), decision_id: z.string().nullable(), revision: z.number(), kind: z.enum(["clarification", "review", "imported_decision"]), prompt: z.string(),
  item_id: z.string(), item_revision: z.number(), project: z.string().nullable(), state: z.string(),
});
const nextDepartureSchema = z.object({
  item_id: z.string(), job_id: z.string(), project_id: z.string(), title: z.string(), priority: z.string().nullable(),
});
const allocationsSchema = z.object({
  capacity: z.number().int().positive().nullable(),
  allocation_sequence: z.number().int().nonnegative(),
  decision_sequence: z.number().int().nonnegative(),
  latest: z.record(z.string(), z.unknown()),
  decisions: z.array(z.unknown()),
});
const followSchema = z.object({
  event: z.literal("roundhouse.work.updated"),
  arguments: z.object({ item_id: z.string(), include_progress: z.boolean() }),
});

function result(structuredContent, text) {
  return { structuredContent, content: [{ type: "text", text }] };
}

export const CHATGPT_INTEGRATION_INSTRUCTIONS = "Capture intent verbatim. For every substantial project or implementation request, use add_to_depot and return the durable Roundhouse item before any executor or Herdr dispatch; never invoke or present a direct implementation runtime. Roundhouse alone owns project inference, material questions, planning, priority, readiness, executor selection, job claims, verification, and shipping. Remote Desktop Commander is not a project execution runtime and must not be used to bypass Roundhouse; it is limited to transport, inspection, connectivity checks, bootstrap, and emergency repair. Use answer_question only with the current durable question revision. On event-capable ChatGPT surfaces, after add_to_depot succeeds, immediately subscribe this conversation to roundhouse.work.updated with the returned item ID; do not call a status tool first. Poll with get_work_status and get_needs_human when Events are unavailable.";

const addToDepotInput = z.object({
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
}).strict();
const answerQuestionInput = z.object({
  id: nonblank(200).describe("The question_id or decision_id returned by get_needs_human."),
  answer: nonblank(100_000).describe("The user's answer in their own words, preserved verbatim."),
  expected_revision: z.number().int().positive().describe("The current question revision returned by get_needs_human."),
}).strict();

const toolSpecs = [
  {
    name: "add_to_depot",
    title: "Add to Roundhouse Depot",
    description: "The only supported intake for ChatGPT implementation requests and substantial project work. Durably capture the user's original intent and relevant conversation context as an authoritative Roundhouse Depot item before any executor or Herdr dispatch; this tool does not execute work or select an executor. Use project_hint only when the user supplied a likely project; Roundhouse performs project inference, triage, planning, claiming, and dispatch. On event-capable ChatGPT surfaces, immediately follow a successful submission by subscribing this conversation to roundhouse.work.updated with the returned item ID; do not request status first. Other clients can poll with get_work_status and get_needs_human.",
    input: addToDepotInput,
    output: z.object({ item: itemSchema, durable: z.boolean(), follow: followSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (service, input) => {
      const value = await service.addToDepot(input, { source: "chatgpt:mcp", actor: "chatgpt-user" });
      const structured = { ...value, follow: { event: "roundhouse.work.updated", arguments: { item_id: value.item.id, include_progress: false } } };
      return result(structured, `Saved authoritative Depot item ${value.item.id} in Roundhouse: ${value.item.state}. Roundhouse triage and dispatch now own any implementation. Event-capable ChatGPT conversations should use the returned follow target; no status lookup is needed.`);
    },
  },
  {
    name: "get_needs_human",
    title: "Get Roundhouse questions",
    description: "List current material questions or review decisions that Roundhouse is waiting for a human to answer. Returns durable IDs and revision guards for answer_question.",
    input: filterSchema,
    output: z.object({ questions: z.array(questionSchema) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (service, filters) => {
      const value = await service.getNeedsHuman(filters);
      return result(value, value.questions.length ? `Roundhouse is waiting on ${value.questions.length} question(s).` : "Nothing in Roundhouse is waiting on you.");
    },
  },
  {
    name: "answer_question",
    title: "Answer a Roundhouse question",
    description: "Record a human answer against a current durable Roundhouse question or decision ID, then immediately re-evaluate project inference and readiness. Reusing an answered or stale revision is rejected.",
    input: answerQuestionInput,
    output: z.object({ item: itemSchema, answer_recorded: z.boolean(), reevaluated: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (service, input) => {
      const value = await service.answerQuestion(input);
      const suffix = value.item.question ? ` Waiting on: ${value.item.question}` : "";
      return result(value, `Answer saved; item ${value.item.id} is now ${value.item.state}.${suffix}`);
    },
  },
  {
    name: "get_work_status",
    title: "Get Roundhouse work status",
    description: "Get compact durable status for Roundhouse Depot items and their work. Use this for progress or outcome questions; it does not change or advance work.",
    input: filterSchema,
    output: z.object({ items: z.array(itemSchema), active_jobs: z.array(activeJobSchema), next_departure: nextDepartureSchema.nullable(), allocations: allocationsSchema,
      projects: z.record(z.string(), z.unknown()),
      project_candidates: z.record(z.string(), z.unknown()), system_metadata: z.record(z.string(), z.unknown()) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (service, filters) => {
      const value = await service.getWorkStatus(filters);
      return result(value, value.items.length ? `Found ${value.items.length} Roundhouse item(s).` : "No matching Roundhouse work found.");
    },
  },
];

const jsonSchema = (schema) => {
  const converted = zodToJsonSchema(schema, { target: "jsonSchema7" });
  delete converted.$schema;
  return converted;
};

export const roundhouseToolCatalog = toolSpecs.map(({ name, title, description, input, output, annotations }) => ({
  name, title, description, inputSchema: jsonSchema(input), outputSchema: jsonSchema(output), annotations,
}));

export async function callRoundhouseTool(service, name, input = {}) {
  const spec = toolSpecs.find((candidate) => candidate.name === name);
  if (!spec) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  const parsed = spec.input.parse(input);
  const value = await spec.run(service, parsed);
  spec.output.parse(value.structuredContent);
  return value;
}

export function roundhouseToolChangesState(name) {
  return toolSpecs.some((spec) => spec.name === name && spec.annotations.readOnlyHint === false);
}

export function createRoundhouseMcpServer(service, { onMutation = async () => {} } = {}) {
  const server = new McpServer(
    { name: "roundhouse-depot", version: "0.1.0" },
    { instructions: CHATGPT_INTEGRATION_INSTRUCTIONS, maxToolInputElements: 1_000 },
  );

  for (const spec of toolSpecs) {
    const shape = spec.input.shape;
    const outputShape = spec.output.shape;
    server.registerTool(spec.name, {
      title: spec.title,
      description: spec.description,
      inputSchema: shape,
      outputSchema: outputShape,
      annotations: spec.annotations,
    }, async (input) => {
      const value = await callRoundhouseTool(service, spec.name, input);
      if (spec.annotations.readOnlyHint === false) Promise.resolve().then(onMutation).catch(() => {});
      return value;
    });
  }

  return server;
}
