import fs from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const packet = JSON.parse(input || "{}");
const log = process.argv[3] || process.env.ROUNDHOUSE_ACCEPTANCE_LOG;
if (log) fs.appendFileSync(log, `${JSON.stringify({ mode: process.argv[2], packet })}\n`);

function decision({ decision, question = "", decision_key = null, approval_required = false, safe_to_execute = true, title = packet.input.text }) {
  const project = packet.projects[0];
  process.stdout.write(JSON.stringify({
    project: project.id,
    project_confidence: 0.99,
    execution_confidence: decision === "clarify" ? 0.2 : 0.99,
    sufficient_context: decision !== "clarify",
    safe_to_execute,
    approval_required,
    decision,
    reason: decision === "clarify" ? question : "Acceptance fixture selected executable work.",
    question,
    decision_key,
    dependencies: [],
    executor: project.executor.kind,
    runtime: project.runtime,
    shipping_policy: project.policy.shipping,
    should_decompose: false,
    work_items: decision === "clarify" ? [] : [{
      title,
      outcome: "Append a verified acceptance entry to feature.txt.",
      acceptance_criteria: [{ description: "feature.txt contains the implemented acceptance entry and the repo is clean.", verification_ids: project.verification.map((rule) => rule.id) }],
    }],
  }));
}

if (process.argv[2] === "decide") {
  const resolved = new Set((packet.resolved_decisions ?? []).map((entry) => entry.decision_key));
  if (packet.input.text.includes("repeat resolved decision")) {
    decision({
      decision: "clarify",
      question: "Is manual README inspection acceptable, or is an executable verification check required?",
      decision_key: "verification-method",
    });
  } else if (packet.input.text.includes("human review acceptance") && !resolved.has("verification-method")) {
    decision({
      decision: "clarify",
      question: "Is manual README inspection acceptable, or is an executable verification check required?",
      decision_key: "verification-method",
    });
  } else if (packet.input.text.includes("human review acceptance")) {
    decision({
      decision: "review",
      question: "Approve the verified disposable change?",
      decision_key: "human-review-gate",
      approval_required: true,
      safe_to_execute: false,
      title: "human review acceptance",
    });
  } else if (packet.input.text.includes("live codex acceptance")) {
    decision({ decision: "execute", title: "Append exactly this line to feature.txt: implemented: live codex acceptance" });
  } else {
    decision({ decision: "execute", title: "autonomous acceptance" });
  }
} else if (process.argv[2] === "deploy") {
  process.stdout.write(JSON.stringify({
    status: "succeeded",
    url: `https://fixture.deploy.invalid/${packet.project}/${packet.commit}`,
    provider_reference: `acceptance-${packet.commit.slice(0, 12)}`,
  }));
} else {
  fs.appendFileSync("feature.txt", `implemented: ${packet.work.title}\n`);
  process.stdout.write("Acceptance fixture implemented the requested change.");
}
