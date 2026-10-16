import assert from "node:assert/strict";
import test from "node:test";
import { authorityPoolConfig, PostgresStorageRepository } from "../src/storage/postgres.js";

test("Aiven PostgreSQL authority pools default to four and expire idle connections", () => {
  assert.deepEqual(authorityPoolConfig({}), { max: 4, idleTimeoutMillis: 10_000 });
  for (const n of [1, 2, 3, 4]) {
    assert.deepEqual(authorityPoolConfig({ ROUNDHOUSE_DB_POOL_MAX: String(n) }),
      { max: n, idleTimeoutMillis: 10_000 });
  }
});

test("reject invalid or oversized pool overrides before connecting", async () => {
  for (const invalid of ["0", "5", "12", "-1", "1.5", "4 ", "abc", ""]) {
    assert.throws(() => authorityPoolConfig({ ROUNDHOUSE_DB_POOL_MAX: invalid }),
      /ROUNDHOUSE_DB_POOL_MAX must be an integer between 1 and 4/);
  }
  await assert.rejects(PostgresStorageRepository.open({
    connectionString: "postgres://example:example@127.0.0.1:1/defaultdb",
    directory: "/tmp",
    node: { name: "budget-test" },
    env: { ROUNDHOUSE_DB_POOL_MAX: "12" },
  }), /ROUNDHOUSE_DB_POOL_MAX must be an integer between 1 and 4/);
});
