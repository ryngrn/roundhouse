import assert from "node:assert/strict";
import test from "node:test";
import { classifyWatchdogEntity, recordWatchdogActivity, watchdogStatus,
  DEFAULT_WATCHDOG_CHECK_INTERVAL_MS, DEFAULT_WATCHDOG_STALE_THRESHOLD_MS } from "../src/workflow/local-watchdog.js";

const now = Date.parse("2026-10-08T12:00:00.000Z");
const active = (changes = {}) => ({ id: "job-1", state: "Executing", created_at: "2026-10-08T11:00:00.000Z",
  updated_at: "2026-10-08T11:00:00.000Z", processes: [], attempts: [{ started_at: "2026-10-08T11:00:00.000Z" }], ...changes });

test("watchdog defaults to a five-minute cadence and ten-minute stale threshold", () => {
  const status = watchdogStatus({ items: {}, jobs: {} }, {}, { now, processAlive: () => false });
  assert.equal(status.check_interval_ms, DEFAULT_WATCHDOG_CHECK_INTERVAL_MS);
  assert.equal(status.stale_threshold_ms, DEFAULT_WATCHDOG_STALE_THRESHOLD_MS);
  assert.equal(status.mode, "observe_only");
});

test("healthy active and sleeping children are credible regardless of CPU activity", () => {
  const entity = active({ processes: [{ pid: 42, phase: "execution", started_at: "2026-10-08T10:00:00.000Z", cpu: 0 }] });
  const result = classifyWatchdogEntity(entity, { now, processAlive: (pid) => pid === 42 });
  assert.equal(result.status, "healthy");
  assert.equal(result.stale, false);
  assert.equal(result.evidence[0].kind, "executor_process");
});

test("dead child and stale UI state are classified stale without mutating the attempt", () => {
  const entity = active({ processes: [{ pid: 42, phase: "execution", cpu: 99 }] });
  const before = structuredClone(entity);
  const result = classifyWatchdogEntity(entity, { now, processAlive: () => false });
  assert.equal(result.status, "stale");
  assert.match(result.reason, /no registered live child/i);
  assert.deepEqual(entity, before);
});

test("live verification process and advancing lease heartbeat protect active work", () => {
  const verification = classifyWatchdogEntity(active({ state: "Verification",
    processes: [{ pid: 51, phase: "verification", started_at: "2026-10-08T11:20:00.000Z" }] }),
  { now, processAlive: () => true });
  assert.equal(verification.evidence[0].kind, "verification_process");
  const heartbeat = classifyWatchdogEntity(active(), { now, processAlive: () => false,
    leaseHeartbeatAt: "2026-10-08T11:55:00.000Z" });
  assert.equal(heartbeat.status, "healthy");
  assert.equal(heartbeat.evidence[0].kind, "lease_heartbeat");
  assert.equal(heartbeat.evidence.length, 1);
});

test("durable progress survives restart and protects the attempt until the threshold", () => {
  const entity = active();
  recordWatchdogActivity(entity, { kind: "durable_progress", phase: "candidate_committed", at: "2026-10-08T11:54:00.000Z" });
  const restored = JSON.parse(JSON.stringify(entity));
  assert.equal(classifyWatchdogEntity(restored, { now, processAlive: () => false }).status, "healthy");
  assert.equal(classifyWatchdogEntity(restored, { now: now + 11 * 60_000, processAlive: () => false }).status, "stale");
});

test("UI labels, worktrees, and CPU alone never establish credible activity", () => {
  const result = classifyWatchdogEntity(active({ display_state: "Chugging Along", cpu: 100,
    prepared: { workspace: "/tmp/roundhouse-worktree" } }), { now, processAlive: () => false });
  assert.equal(result.status, "stale");
  assert.deepEqual(result.evidence, []);
});

test("process inspection errors withhold stale classification to prevent false positives", () => {
  const result = classifyWatchdogEntity(active({ processes: [{ pid: 42, phase: "execution" }] }), {
    now, processAlive: () => { throw new Error("inspection denied"); },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.stale, false);
  assert.match(result.error, /inspection denied/);
  const status = watchdogStatus({ items: {}, jobs: { one: active({ processes: [{ pid: 42 }] }) } }, {}, {
    now, processAlive: () => { throw new Error("inspection denied"); },
  });
  assert.match(status.error, /inspection denied/);
});

test("older activity records cannot move the durable credible-activity watermark backwards", () => {
  const entity = active();
  recordWatchdogActivity(entity, { kind: "durable_progress", at: "2026-10-08T11:58:00.000Z" });
  recordWatchdogActivity(entity, { kind: "executor_process", at: "2026-10-08T11:40:00.000Z", pid: 42 });
  assert.equal(entity.watchdog_evidence.last_credible_activity_at, "2026-10-08T11:58:00.000Z");
});

