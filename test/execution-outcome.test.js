import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveExecutionOutcome, executionOutcomeMetricStatus, nativeProvenanceStages, validateExecutionOutcome } from "../src/workflow/execution-outcome.js";
import { Store } from "../src/workflow/store.js";
import { Engine } from "../src/workflow/engine.js";

const at = "2026-10-08T12:00:00.000Z";
const evidence = (stage) => ({ recorded_at: at, evidence_links: [{ kind: "state", uri: `roundhouse://job/job-1/${stage}` }] });
const native = () => ({
  schema_version: 1,
  classification: "native_success",
  recorded_at: at,
  recorded_by: "roundhouse",
  historical_import: false,
  execution_path: [{ kind: "local_codex", provider: "codex", runtime: "local", machine: "studio" }],
  provenance: Object.fromEntries(nativeProvenanceStages.map((stage) => [stage, evidence(stage)])),
  reason: null,
  exception_expected: null,
  human_intervention_required: false,
  human_intervention_count: 0,
  human_minutes: null,
  evidence_links: [{ kind: "delivery", uri: "roundhouse://job/job-1/delivery" }],
});

test("execution outcome: native success requires all five durable provenance stages", () => {
  const value = native();
  assert.equal(validateExecutionOutcome(value).classification, "native_success");
  delete value.provenance.verification;
  assert.throws(() => validateExecutionOutcome(value), /missing verification/);
  assert.throws(() => validateExecutionOutcome({ ...native(), provenance: {}, state: "Shipped" }), /missing intake/);
});

test("execution outcome: exception success records reason, authorization, intervention, path, and evidence", () => {
  const value = {
    ...native(), classification: "exception_success", provenance: { intake: evidence("intake") },
    execution_path: [{ kind: "manual_rdc", detail: "Completed in the operator session." }],
    reason: { code: "missing_capability", note: "The configured worker could not operate the native application." },
    exception_expected: false, human_intervention_required: true, human_intervention_count: 2, human_minutes: 12,
  };
  assert.equal(validateExecutionOutcome(value).exception_expected, false);
  const withoutEstimate = structuredClone(value);
  delete withoutEstimate.human_minutes;
  assert.equal(validateExecutionOutcome(withoutEstimate).human_minutes, null);
  assert.throws(() => validateExecutionOutcome({ ...value, reason: null }), /structured reason/);
});

test("execution outcome: recovered and unsuccessful attempts retain structured cause and actual path", () => {
  const recovered = {
    ...native(), classification: "recovered_success", provenance: { delivery: evidence("delivery") },
    execution_path: [{ kind: "herdr_codex" }, { kind: "operator_reconciliation" }],
    reason: { code: "stale_worker", note: "The expired owner was reconciled against durable delivery evidence." },
    human_intervention_required: true, human_intervention_count: 1, human_minutes: 3,
  };
  assert.equal(validateExecutionOutcome(recovered, { job: { state: "Shipped" } }).classification, "recovered_success");
  const failed = {
    ...recovered, classification: "failed_or_abandoned", execution_path: [{ kind: "local_command" }],
    reason: { code: "provider_limit", note: "No eligible provider remained." },
    human_intervention_required: false, human_intervention_count: 0, human_minutes: null,
  };
  assert.equal(validateExecutionOutcome(failed, { job: { state: "Blocked" } }).classification, "failed_or_abandoned");
  assert.throws(() => validateExecutionOutcome(native(), { job: { state: "Ready" } }), /requires a Shipped job/);
});

test("execution outcome: legacy and imported work is excluded instead of inferred from Shipped", () => {
  assert.deepEqual(executionOutcomeMetricStatus({ state: "Shipped" }), { eligible: false, reason: "unclassified", classification: null });
  assert.deepEqual(executionOutcomeMetricStatus({ state: "Shipped", execution_outcome_exclusion: "historical_import" }),
    { eligible: false, reason: "historical_import", classification: null });
  assert.deepEqual(executionOutcomeMetricStatus({ state: "Shipped", execution_outcome: native() }),
    { eligible: true, reason: null, classification: "native_success" });
});

test("execution outcome: local authoritative writes enforce the contract and preserve legacy records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-outcome-"));
  const store = new Store(directory);
  store.change((data) => { data.jobs.legacy = { id: "legacy", state: "Shipped" }; });
  assert.equal(store.read().jobs.legacy.execution_outcome, undefined);
  assert.throws(() => store.change((data) => {
    data.jobs.legacy.execution_outcome = { ...native(), provenance: {} };
  }), /missing intake/);
  assert.equal(store.read().jobs.legacy.execution_outcome, undefined);
  store.change((data) => { data.jobs.legacy.execution_outcome = native(); });
  assert.equal(store.read().jobs.legacy.execution_outcome.classification, "native_success");
});

test("exception completion annotation is evidenced, auditable, revision guarded, and idempotent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-exception-completion-"));
  const store = new Store(directory);
  store.change((data) => {
    data.items.item = { id: "item", state: "Ready", revision: 1, created_at: at, updated_at: at,
      input: { text: "Finish the native-app task" }, job_ids: ["job"], history: [] };
    data.jobs.job = { id: "job", parent_id: "item", project_id: "project", state: "Blocked", revision: 4,
      created_at: at, updated_at: at, work: { title: "Finish it" }, attempts: [],
      history: [{ from: "Ready", to: "Blocked", at, reason: "Worker lacks native-app control." }] };
    data.jobs.job.execution_outcome = deriveExecutionOutcome(data.jobs.job, data.items.item);
  });
  const engine = new Engine({ store, config: { projects: [], execution: {} } });
  const annotation = {
    annotation_id: "rdc-finish-1", actor: "operator", expected: false,
    reason: { code: "missing_capability", note: "RDC was required to operate the native application." },
    execution_path: [{ kind: "manual_rdc", machine: "studio", detail: "Completed the native-app step." }],
    evidence_links: [{ kind: "screenshot", uri: "roundhouse://evidence/rdc-finish-1", label: "Completion screenshot" }],
    human_intervention_count: 2, human_minutes: 8,
  };

  assert.throws(() => engine.annotateExceptionCompletion("missing", 1, annotation), /existing job/);
  assert.throws(() => engine.annotateExceptionCompletion("job", 3, annotation), /current job revision/);
  assert.throws(() => engine.annotateExceptionCompletion("job", 4, { ...annotation, evidence_links: [] }), /durable evidence link/);
  assert.equal(store.read().jobs.job.state, "Blocked", "insufficient evidence leaves the unsuccessful lifecycle unchanged");
  assert.equal(store.read().jobs.job.execution_outcome.classification, "failed_or_abandoned");

  const completed = engine.annotateExceptionCompletion("job", 4, annotation);
  assert.equal(completed.state, "Shipped");
  assert.equal(completed.execution_outcome.classification, "exception_success");
  assert.equal(completed.execution_outcome.exception_expected, false);
  assert.equal(completed.execution_outcome.execution_path[0].kind, "manual_rdc");
  assert.equal(completed.execution_outcome.human_intervention_count, 2);
  assert.equal(completed.execution_outcome.evidence_links.some((entry) => entry.uri === annotation.evidence_links[0].uri), true);
  assert.equal(completed.execution_outcome.provenance.executor_ownership, undefined,
    "manual completion does not manufacture native executor provenance");
  assert.match(completed.history.at(-1).reason, /native provenance was not asserted/);
  assert.equal(completed.shipping.policy, "exception_annotation");
  assert.equal(completed.shipping.pushed, false);

  const replay = engine.annotateExceptionCompletion("job", 4, annotation);
  assert.equal(replay.revision, completed.revision, "retrying the same annotation does not append history");
  assert.equal(replay.history.length, completed.history.length);
  assert.throws(() => engine.annotateExceptionCompletion("job", 4, { ...annotation, human_minutes: 9 }), /different exception completion data/);
});

function lifecycle({ runtime = "local", executor = "codex", state = "Shipped" } = {}) {
  const item = { id: "item-1", created_at: at, input: { text: "Do the work" } };
  const attempt = { number: 1, started_at: at, finished_at: at, status: state === "Shipped" ? "completed" : "blocked",
    run: { id: "run-1", provider_id: "provider-1", status: state === "Shipped" ? "completed" : "blocked" },
    provider_evidence: { selected: { id: "provider-1", kind: executor }, invoked: { id: "provider-1", kind: executor }, invoked_at: at },
    execution: runtime === "herdr" ? { remote_execution: { runtime: "herdr", machine_selector: "studio" } } : {},
    verification: { passed: true, at, checks: [] } };
  const job = { id: "job-1", parent_id: item.id, state, updated_at: at, project_context: { runtime, executor: { kind: executor },
    ...(runtime === "herdr" ? { herdr: { machine: "studio" } } : {}) }, attempts: [attempt],
    history: [{ from: "Ready", to: "Executing", at, reason: "claimed" }, { from: "Verification", to: state, at, reason: "done" }],
    delivery_intent: { reconciliation: { status: "confirmed", confirmed_at: at } },
    shipping: { timestamp: at, commit: "a".repeat(40), verification: attempt.verification } };
  return { item, job };
}

test("execution outcome: derives native local and Herdr paths only from complete lifecycle evidence", () => {
  const local = lifecycle();
  assert.equal(deriveExecutionOutcome(local.job, local.item).classification, "native_success");
  assert.equal(deriveExecutionOutcome(local.job, local.item).execution_path[0].kind, "local_codex");
  const herdr = lifecycle({ runtime: "herdr", executor: "claude" });
  assert.equal(deriveExecutionOutcome(herdr.job, herdr.item).classification, "native_success");
  assert.equal(deriveExecutionOutcome(herdr.job, herdr.item).execution_path[0].kind, "herdr_claude");
  delete local.job.attempts[0].provider_evidence.invoked;
  assert.equal(deriveExecutionOutcome(local.job, local.item), null, "Shipped without ownership evidence is not native success");
});

test("execution outcome: derives recovery, manual exception, and failed paths with explainable reasons", () => {
  const recovered = lifecycle({ runtime: "herdr" });
  recovered.job.reconciliation = { status: "confirmed", reason: "Expired stale worker was reconciled with the remote commit.",
    confirmed_at: at, human_intervention_count: 1 };
  const recoveredOutcome = deriveExecutionOutcome(recovered.job, recovered.item);
  assert.equal(recoveredOutcome.classification, "recovered_success");
  assert.equal(recoveredOutcome.reason.code, "stale_worker");
  assert.equal(recoveredOutcome.execution_path.at(-1).kind, "operator_reconciliation");

  const manual = lifecycle();
  manual.job.untracked_path_evidence = { execution_path: [{ kind: "manual_rdc", detail: "Operator completed the native-app step." }],
    reason: { code: "missing_capability", note: "The worker could not control the native application." }, expected: false,
    human_intervention_count: 2, human_minutes: 8 };
  const manualOutcome = deriveExecutionOutcome(manual.job, manual.item, { recordedBy: "operator" });
  assert.equal(manualOutcome.classification, "exception_success");
  assert.equal(manualOutcome.exception_expected, false);
  assert.equal(manualOutcome.human_intervention_count, 2);

  const failed = lifecycle({ state: "Blocked" });
  failed.job.shipping = null;
  failed.job.hold = { code: "interrupted_attempt", reason: "Expired owner lease interrupted execution." };
  failed.job.attempts[0].failure = failed.job.hold.reason;
  const failedOutcome = deriveExecutionOutcome(failed.job, failed.item);
  assert.equal(failedOutcome.classification, "failed_or_abandoned");
  assert.equal(failedOutcome.reason.code, "stale_worker");
});
