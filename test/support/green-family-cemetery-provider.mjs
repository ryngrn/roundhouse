import fs from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const packet = input ? JSON.parse(input) : {};
const [mode, argument] = process.argv.slice(2);

if (mode === "decide") {
  const project = packet.projects[0];
  process.stdout.write(JSON.stringify({
    project: project.id,
    project_confidence: 1,
    execution_confidence: 1,
    sufficient_context: true,
    safe_to_execute: true,
    approval_required: false,
    decision: "execute",
    reason: "The deterministic cemetery workflow is fully scoped.",
    questions: [],
    question: null,
    decision_key: null,
    dependencies: [],
    executor: project.executor.kind,
    runtime: project.runtime,
    shipping_policy: project.policy.shipping,
    should_decompose: true,
    reconcile_with: null,
    blocked_on: [],
    work_items: [{
      title: "Research Green Family Cemetery records",
      outcome: "Cemetery facts and their fixture sources are recorded.",
      repository_required: false,
      required_capabilities: ["research", "connected-source"],
      action_class: "read_only",
      schedule: null,
      acceptance_criteria: [{ description: "Every finding retains a source URI and retrieval time.", verification_ids: [] }],
    }, {
      title: "Produce the Green Family Cemetery research brief",
      outcome: "A durable, cited Markdown brief is available for inspection.",
      repository_required: false,
      required_capabilities: ["artifact"],
      action_class: "read_only",
      schedule: null,
      acceptance_criteria: [{ description: "The cited brief is versioned as a durable output.", verification_ids: [] }],
    }, {
      title: "Review new Green Family Cemetery records",
      outcome: "A scheduled follow-up records the next research checkpoint.",
      repository_required: false,
      required_capabilities: ["scheduling"],
      action_class: "read_only",
      schedule: { not_before: argument, recurrence: null, wait_for: null },
      acceptance_criteria: [{ description: "The follow-up remains ineligible until its absolute timestamp.", verification_ids: [] }],
    }, {
      title: "Propose a Green Family Cemetery records request",
      outcome: "A bounded request proposal is recorded without contacting a custodian.",
      repository_required: false,
      required_capabilities: ["external-action"],
      action_class: "consequential",
      schedule: null,
      acceptance_criteria: [{ description: "The proposal is scoped and is never sent by the fixture.", verification_ids: [] }],
    }],
  }));
  process.exit(0);
}

if (mode !== "execute") throw new Error(`Unknown fixture mode: ${mode}`);

const provider = packet.provider.id;
fs.appendFileSync(argument, `${JSON.stringify({ provider, run_id: packet.run.id, title: packet.work.title })}\n`);

if (provider === "green-research-fixture") {
  const sources = [{
    uri: "fixture://green-family-cemetery/register-1904",
    title: "Green Family Cemetery register (fixture)",
    retrieved_at: "2026-10-03T12:00:00.000Z",
  }, {
    uri: "fixture://green-family-cemetery/plot-map-1912",
    title: "Green Family Cemetery plot map (fixture)",
    retrieved_at: "2026-10-03T12:00:00.000Z",
  }];
  fs.writeFileSync("sources.json", `${JSON.stringify(sources, null, 2)}\n`);
  process.stdout.write(JSON.stringify({
    summary: "Recorded deterministic Green Family Cemetery findings with source provenance.",
    findings: [{ claim: "The fixture register and plot map identify the same cemetery site.", sources: sources.map(({ uri }) => uri) }],
    sources,
  }));
} else if (provider === "green-artifact-fixture") {
  fs.writeFileSync("green-family-cemetery-brief.md", `# Green Family Cemetery research brief

The deterministic register and plot-map fixtures identify the same cemetery site.

## Sources

- [Green Family Cemetery register (fixture)](fixture://green-family-cemetery/register-1904)
- [Green Family Cemetery plot map (fixture)](fixture://green-family-cemetery/plot-map-1912)
`);
  process.stdout.write(JSON.stringify({
    summary: "Produced a durable cited Green Family Cemetery brief.",
    citations: ["fixture://green-family-cemetery/register-1904", "fixture://green-family-cemetery/plot-map-1912"],
  }));
} else if (provider === "green-scheduling-fixture") {
  process.stdout.write(JSON.stringify({
    summary: "Recorded the scheduled Green Family Cemetery research checkpoint.",
    checkpoint: { scheduled_for: packet.work.schedule.not_before, status: "due" },
  }));
} else if (provider === "green-action-fixture") {
  process.stdout.write(JSON.stringify({
    summary: "Prepared a scoped records-request proposal without sending it.",
    action: {
      kind: "records_request",
      target: "fixture cemetery records custodian",
      scope: "Ask only for the register page and plot-map revision represented by the fixture sources.",
      status: "proposed_not_sent",
      external_side_effects: false,
    },
  }));
} else {
  throw new Error(`Unknown execution fixture provider: ${provider}`);
}
