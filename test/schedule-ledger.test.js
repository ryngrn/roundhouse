import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PostgresStorageRepository } from "../src/storage/postgres.js";

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/storage/migrations");
function fixture({ due = [], duplicate = false, fail = false } = {}) {
  const queries = [];
  const schedules = new Map();
  const claimed = new Set();
  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO roundhouse.schedules")) {
        const [id, key, kind, interval, next, payload] = parameters;
        if (schedules.has(key)) return { rows: [], rowCount: 0 };
        const row = { id, schedule_key: key, kind, interval_minutes: interval, next_due_at: next, payload, enabled: false, revision: 1 };
        schedules.set(key, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("FROM roundhouse.schedules WHERE schedule_key")) {
        const row = schedules.get(parameters[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("FOR UPDATE SKIP LOCKED")) return { rows: due, rowCount: due.length };
      if (sql.includes("INSERT INTO roundhouse.schedule_occurrences")) {
        if (fail) throw new Error("database unavailable");
        const [id, schedule_id, scheduled_for, , kind] = parameters;
        const key = `${schedule_id}:${scheduled_for.toISOString()}`;
        if (duplicate || claimed.has(key)) return { rows: [], rowCount: 0 };
        claimed.add(key);
        return { rows: [{ id, schedule_id, scheduled_for, kind, status: "due" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE roundhouse.schedules SET")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected scheduler query: ${sql.slice(0, 80)}`);
    },
    release() {},
  };
  const store = new PostgresStorageRepository({
    pool: { connect: async () => client }, directory: os.tmpdir(),
    node: { id: "00000000-0000-4000-8000-000000000001", name: "fixture", capabilities: [] },
  });
  return { store, queries };
}

test("schedule migration is additive, disabled by default, and deduplicates by schedule plus due instant", () => {
  const sql = fs.readFileSync(path.join(migrations, "006_schedule_ledger.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS roundhouse\.schedules/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS roundhouse\.schedule_occurrences/);
  assert.match(sql, /enabled boolean NOT NULL DEFAULT false/);
  assert.match(sql, /UNIQUE \(schedule_id, scheduled_for\)/);
  assert.match(sql, /interval_minutes BETWEEN 5 AND 10080/);
  assert.doesNotMatch(sql, /TRUNCATE|DROP TABLE|DELETE FROM|pg_cron|CREATE EXTENSION/);
});

test("schedule registration is dormant and idempotent, but configuration drift is rejected", async () => {
  const { store, queries } = fixture();
  const input = { key: "roundhouse.health", kind: "health_check", intervalMinutes: 15,
    nextDueAt: "2026-10-15T04:00:00.000Z", payload: { source: "control-plane" } };
  const first = await store.registerDisabledSchedule(input);
  assert.equal(first.enabled, false);
  const repeat = await store.registerDisabledSchedule(input);
  assert.equal(repeat.id, first.id);
  await assert.rejects(store.registerDisabledSchedule({ ...input, intervalMinutes: 5 }), /different configuration/);
  await assert.rejects(store.registerDisabledSchedule({ ...input, key: "test.invalid", intervalMinutes: 1 }), /5 minutes/);
  await assert.rejects(store.registerDisabledSchedule({ ...input, kind: "deploy" }), /Unsupported/);
  assert.equal(queries.filter(({ sql }) => sql === "COMMIT").length, 2);
  assert.equal(queries.at(-1).sql, "ROLLBACK");
});

test("due receipts use SKIP LOCKED, bounded batches, stable occurrence identity and catch-up without replay", async () => {
  const first = { id: "00000000-0000-4000-8000-000000000001", schedule_key: "first", kind: "health_check",
    interval_minutes: 5, next_due_at: new Date("2026-10-14T19:00:00Z"), revision: 1, payload: {} };
  const second = { ...first, id: "00000000-0000-4000-8000-000000000002", schedule_key: "second" };
  const { store, queries } = fixture({ due: [first, second] });
  const claimed = await store.recordDueSchedules({ limit: 2 });
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((row) => row.schedule_id), [first.id, second.id]);
  const select = queries.find(({ sql }) => sql.includes("FOR UPDATE SKIP LOCKED"));
  assert.match(select.sql, /WHERE enabled AND next_due_at<=clock_timestamp\(\)/);
  assert.deepEqual(select.parameters, [2]);
  const updates = queries.filter(({ sql }) => sql.includes("UPDATE roundhouse.schedules SET"));
  assert.equal(updates.length, 2);
  assert.ok(updates.every(({ sql }) => /floor\(greatest\(0,extract\(epoch/.test(sql)));
  assert.equal(queries.at(-1).sql, "COMMIT");
  await assert.rejects(store.recordDueSchedules({ limit: 51 }), /1–50/);
});

test("duplicate occurrence cannot produce another receipt; database failure rolls the batch back", async () => {
  const schedule = { id: "00000000-0000-4000-8000-000000000001", kind: "health_check",
    interval_minutes: 5, next_due_at: new Date("2026-10-14T19:00:00Z"), revision: 1, payload: {} };
  const duplicate = fixture({ due: [schedule], duplicate: true });
  assert.deepEqual(await duplicate.store.recordDueSchedules(), []);
  assert.equal(duplicate.queries.at(-1).sql, "COMMIT");
  const failing = fixture({ due: [schedule], fail: true });
  await assert.rejects(failing.store.recordDueSchedules(), /database unavailable/);
  assert.equal(failing.queries.at(-1).sql, "ROLLBACK");
  assert.equal(failing.queries.some(({ sql }) => sql.includes("UPDATE roundhouse.schedules SET")), false);
});
