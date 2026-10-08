import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/workflow/store.js";
import { dispatchConsiderations } from "../src/workflow/scheduler.js";
import { assessJobEligibility, ensureNextOccurrence, initializeJobSchedule, nextOccurrence, nextScheduledWake, recordConditionSignal } from "../src/workflow/scheduling.js";
import { displayState } from "../src/workflow/presentation.js";
import { statusView } from "../src/workflow/views.js";

const project = { id: "example", status: "active", weight: 1, max_concurrent_runs: 1, repository_required: false,
  required_capabilities: [], resource_requirements: {}, policy: { shipping: "commit_only" } };
const execution = { capacity: 1, capabilities: [], resource_limits: {} };

function job(id = "item-1") {
  return { id, parent_id: "item", project_id: "example", position: 0, state: "Ready", revision: 1,
    created_at: "2026-01-01T00:00:00.000Z", history: [], dependencies: [], attempts: [], processes: [],
    work: { title: "Scheduled work" }, project_context: { status: "active" } };
}

test("scheduled work: a persisted timestamp remains ineligible across restart and becomes explainably due", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-time-wait-"));
  const store = new Store(directory);
  store.change((data) => {
    data.projects.example = {};
    data.items.item = { id: "item", state: "Ready", revision: 1, input: { text: "Later" }, questions: [], job_ids: ["item-1"], history: [] };
    data.jobs["item-1"] = initializeJobSchedule(job(), { not_before: "2026-01-02T00:00:00Z", recurrence: null, wait_for: null }, {}, {
      now: Date.parse("2026-01-01T00:00:00Z"),
    });
  });

  const restarted = new Store(directory).read();
  const waiting = dispatchConsiderations(restarted, [project], execution, { canDispatch: () => true, now: Date.parse("2026-01-01T12:00:00Z") })[0];
  assert.equal(waiting.eligible, false);
  assert.equal(waiting.checks.schedule.code, "time_wait");
  assert.equal(displayState("Ready", { waiting: "time" }), "Waiting for departure time");
  assert.equal(nextScheduledWake(restarted, { now: Date.parse("2026-01-01T12:00:00Z") }), "2026-01-02T00:00:00.000Z");

  const due = dispatchConsiderations(restarted, [project], execution, { canDispatch: () => true, now: Date.parse("2026-01-02T00:00:00Z") })[0];
  assert.equal(due.eligible, true);
  assert.equal(due.checks.schedule.code, "time_due");
});

test("scheduled work: external conditions are durable waits, not human questions or operational blocks", () => {
  const data = { items: {}, jobs: {}, projects: { example: {} }, system_metadata: {}, outbox: [] };
  data.items.item = { id: "item", state: "Ready", revision: 1, input: { text: "After import" }, questions: [], job_ids: ["item-1"], history: [] };
  data.jobs["item-1"] = initializeJobSchedule(job(), { not_before: null, recurrence: null,
    wait_for: { key: "source.imported", description: "The source import is complete" } }, {}, { now: Date.parse("2026-01-01T00:00:00Z") });

  const before = statusView(data).items[0];
  assert.equal(before.state, "Ready");
  assert.equal(before.needs_you, false);
  assert.equal(before.waiting.kind, "condition");
  assert.equal(before.display_state, "Waiting for its signal");
  assert.equal(dispatchConsiderations(data, [project], execution, { canDispatch: () => true })[0].checks.schedule.code, "condition_wait");

  const signal = recordConditionSignal(data, "source.imported", { satisfied: true, actor: "importer", details: { batch: 7 }, at: Date.parse("2026-01-01T01:00:00Z") });
  assert.equal(signal.revision, 1);
  assert.equal(assessJobEligibility(data.jobs["item-1"], data.system_metadata.condition_signals).eligible, true);
  assert.deepEqual(data.items.item.questions, []);
  assert.equal(data.jobs["item-1"].state, "Ready");
  assert.match(data.jobs["item-1"].eligibility.transitions.at(-1).reason, /satisfied by importer/);
});

test("scheduled work: recurring timestamps derive from the anchor and occurrence index without duplicate keys", () => {
  const first = initializeJobSchedule(job(), { not_before: null, wait_for: null, recurrence: {
    start_at: "2026-01-01T00:00:00Z", interval_seconds: 3600, max_occurrences: 3, end_at: null,
  } }, {}, { now: Date.parse("2025-12-31T00:00:00Z") });
  const second = nextOccurrence(first, { position: 1, now: Date.parse("2026-01-01T00:30:00Z") });
  const retried = nextOccurrence(first, { position: 1, now: Date.parse("2026-01-01T00:45:00Z") });
  const third = nextOccurrence(second, { position: 2, now: Date.parse("2026-01-01T02:30:00Z") });

  assert.equal(second.eligibility.eligible_at, "2026-01-01T01:00:00.000Z");
  assert.equal(third.eligibility.eligible_at, "2026-01-01T02:00:00.000Z");
  assert.equal(second.occurrence_key, retried.occurrence_key);
  assert.equal(second.id, retried.id);
  assert.equal(nextOccurrence(third, { position: 3 }), null);
});

test("scheduled work: recurrence materialization is idempotent in durable control-plane state", () => {
  const first = initializeJobSchedule(job(), { not_before: null, wait_for: null, recurrence: {
    start_at: "2026-01-01T00:00:00Z", interval_seconds: 3600, max_occurrences: 2, end_at: null,
  } }, {}, { now: Date.parse("2025-12-31T00:00:00Z") });
  first.work.complexity = { actual_outcome: { status: "shipped", cost_usd: 0, summary: "First occurrence." } };
  first.state = "Shipped";
  const data = { items: { item: { id: "item", job_ids: [first.id], decision: {
    complexity: { actual_outcome: { status: "shipped", cost_usd: 0, summary: "First occurrence." } },
  } } }, jobs: { [first.id]: first } };

  const created = ensureNextOccurrence(data, first, { now: Date.parse("2026-01-01T00:30:00Z") });
  const repeated = ensureNextOccurrence(data, first, { now: Date.parse("2026-01-01T00:45:00Z") });

  assert.equal(created.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.successor.id, created.successor.id);
  assert.deepEqual(data.items.item.job_ids, [first.id, created.successor.id]);
  assert.equal(created.successor.work.complexity.actual_outcome, null);
  assert.equal(data.items.item.decision.complexity.actual_outcome, null);
  assert.equal(Object.values(data.jobs).filter((entry) => entry.occurrence_key === created.successor.occurrence_key).length, 1);
});

test("scheduled work: timestamps without an explicit timezone are rejected", () => {
  assert.throws(() => initializeJobSchedule(job(), { not_before: "2026-01-02T00:00:00", recurrence: null, wait_for: null }),
    /absolute ISO timestamp with a timezone/);
});
