// Deterministic external providers for tests/demo; no model account is required.
import fs from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const packet = JSON.parse(input);
if (process.argv[2] === "decide") {
  if (process.argv[3] === "cleanup") {
    const text = packet.candidate.original_request ?? packet.candidate.title ?? "";
    const action = text.includes("cleanup delete") ? "delete" : text.includes("cleanup repurpose") ? "repurpose" : text.includes("cleanup ask") ? "ask" : "keep";
    process.stdout.write(JSON.stringify({
      action, confidence: action === "ask" ? 0.55 : 0.91,
      reason: action === "delete" ? "The fixture is obsolete." : action === "repurpose" ? "A smaller useful outcome remains." : action === "ask" ? "Two plausible paths remain." : "The fixture should remain held.",
      active_scope: action === "repurpose" ? "Deliver the still-relevant smaller outcome." : "",
      removed_scope: action === "repurpose" ? ["The obsolete prerequisite and its old implementation path."] : [],
      question: action === "ask" ? "Should I preserve the smaller outcome or delete this work?" : null,
      options: action === "ask" ? ["Preserve and replan the smaller outcome", "Delete the work"] : [],
      dependent_actions: packet.dependents.map((entry) => ({ id: entry.id, confidence: 0.91, active_scope: entry.outcome ?? entry.title, removed_scope: [`Dependency on ${packet.candidate.id}`] })),
    }));
    process.exit(0);
  }
  const project = packet.projects.find((p) => p.id === packet.input.project_id) ?? packet.projects[0];
  const text = packet.input.text;
  const low = text.includes("ambiguous") && packet.clarifications.length === 0;
  const review = text.includes("approval");
  const titles = text.includes("decompose") ? ["first part", "second part"] : [text];
  process.stdout.write(JSON.stringify({
    project: low ? null : project.id, project_confidence: low ? 0.2 : 0.98, execution_confidence: low ? 0.2 : 0.97,
    sufficient_context: !low, safe_to_execute: true, approval_required: review,
    decision: low ? "clarify" : review ? "review" : "execute", reason: "Deterministic fixture with configured checks.",
    question: low ? "Which project and outcome?" : review ? "Approve this change?" : "",
    decision_key: low ? "fixture:project-outcome" : review ? "fixture:approval" : null,
    dependencies: [], executor: project.executor.kind, runtime: project.runtime, shipping_policy: project.policy.shipping,
    should_decompose: titles.length > 1,
    work_items: titles.map((title) => ({ title, outcome: "Append the requested entry to the feature file.", acceptance_criteria: [{ description: "Feature file contains a valid implemented entry.", verification_ids: ["feature"] }] })),
  }));
} else if (process.argv[2] === "deploy") {
  process.stdout.write(JSON.stringify({
    status: "succeeded",
    url: `https://deploy.fixture.invalid/${packet.project}/${packet.commit}`,
    provider_reference: `fixture-${packet.commit.slice(0, 12)}`,
  }));
} else {
  if (packet.work.title.includes("executor fails")) process.exit(7);
  if (packet.work.title.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 1500));
  const value = packet.work.title.includes("repair") && !packet.previous_failure ? "invalid" : `implemented: ${packet.work.title}`;
  fs.appendFileSync("feature.txt", `${value}\n`);
  if (packet.previous_failure) {
    fs.writeFileSync("feature.txt", fs.readFileSync("feature.txt", "utf8").replaceAll("invalid\n", ""));
  }
  process.stdout.write("Fixture change implemented.");
}
