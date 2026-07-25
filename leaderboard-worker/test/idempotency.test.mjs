#!/usr/bin/env node
// Mutation idempotency and refusal-policy harness.
//
// Traceability:
// TS-LB3-DB-005 TS-LB3-DB-006 TS-LB3-REL-001
// TS-LB3-REL-011 TS-LB3-REL-014 TS-LB3-RELY-004
// TS-LB3-RELY-005 TS-LB3-INVITE-008 TS-LB3-INVITE-011
// TS-LB3-ECON-004 TS-LB3-ECON-005 TS-LB3-SOCIAL-001
// TS-LB3-SEC-010 TS-LB3-SEC-015.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "lb-idempotency-"));

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.first(this.sql, this.args); }
  run() { return this.db.run(this.sql, this.args); }
}

class IdempotencyD1 {
  constructor() { this.rows = new Map(); }
  prepare(sql) { return new Statement(this, sql); }
  key(player, route, key) { return `${player}\u0000${route}\u0000${key}`; }
  async first(sql, args) {
    if (sql.includes("FROM idempotency")) {
      return this.rows.get(this.key(args[0], args[1], args[2])) ?? null;
    }
    throw new Error(`unhandled first: ${sql}`);
  }
  async run(sql, args) {
    if (sql.includes("INSERT OR IGNORE INTO idempotency")) {
      const [player, route, key, requestHash, result, expiresAt] = args;
      const mapKey = this.key(player, route, key);
      if (!this.rows.has(mapKey)) {
        this.rows.set(mapKey, { request_hash: requestHash, result, expires_at: expiresAt });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    throw new Error(`unhandled run: ${sql}`);
  }
}

try {
  execSync(
    `npx --prefix ../read-worker esbuild src/social.ts --bundle --format=esm --outfile=${join(out, "social.mjs")}`,
    { cwd: root, stdio: "pipe" },
  );
  const social = await import(join(out, "social.mjs"));
  const db = new IdempotencyD1();
  const env = { SOCIAL_DB: db };
  const ctx = (playerId) => ({
    playerId, family: `family-${playerId}`, nickname: playerId,
    boardRevision: 0, sessionVersion: 1,
  });
  const request = (key) => new Request("https://worker.test/v3/leaderboard/mutes", {
    method: "POST", headers: { "idempotency-key": key },
  });

  let calls = 0;
  const first = await social.withIdempotency(
    request("same"), env, ctx("p1"), "mutes", '{"playerId":"p2"}',
    async () => { calls += 1; return { code: "OK", data: { generation: 7 } }; },
  );
  const replay = await social.withIdempotency(
    request("same"), env, ctx("p1"), "mutes", '{"playerId":"p2"}',
    async () => { calls += 1; return { code: "INTERNAL" }; },
  );
  assert.deepEqual(replay, first);
  assert.equal(calls, 1, "same actor/route/key/body executed twice");

  const mismatch = await social.withIdempotency(
    request("same"), env, ctx("p1"), "mutes", '{"playerId":"p3"}',
    async () => { throw new Error("must not run"); },
  );
  assert.equal(mismatch.code, "IDEMPOTENCY_MISMATCH");

  // Scope includes actor and route: neither can read/reuse another result.
  await social.withIdempotency(
    request("same"), env, ctx("p2"), "mutes", '{"playerId":"p2"}',
    async () => ({ code: "OK", data: { actor: "p2" } }),
  );
  await social.withIdempotency(
    request("same"), env, ctx("p1"), "blocks", '{"playerId":"p2"}',
    async () => ({ code: "OK", data: { route: "blocks" } }),
  );
  assert.equal(db.rows.size, 3);

  // INTERNAL remains retryable and is never persisted as a semantic result.
  const failed = await social.withIdempotency(
    request("internal"), env, ctx("p1"), "mutes", "{}",
    async () => ({ code: "INTERNAL" }),
  );
  assert.equal(failed.code, "INTERNAL");
  assert.equal([...db.rows.keys()].some((key) => key.endsWith("\u0000internal")), false);

  // Missing/oversized keys reject before mutation.
  let ran = false;
  const missing = await social.withIdempotency(
    request(""), env, ctx("p1"), "mutes", "{}", async () => {
      ran = true; return { code: "OK" };
    },
  );
  assert.equal(missing.code, "SCHEMA_INVALID");
  const oversized = await social.withIdempotency(
    request("x".repeat(65)), env, ctx("p1"), "mutes", "{}", async () => {
      ran = true; return { code: "OK" };
    },
  );
  assert.equal(oversized.code, "SCHEMA_INVALID");
  assert.equal(ran, false);

  // Stored lifetime covers the specified 48-hour retry/stuck horizon.
  const now = Date.now();
  for (const row of db.rows.values()) {
    assert.ok(row.expires_at - now >= 48 * 3_600_000 - 1_000);
  }

  console.log("idempotency.test OK — replay/mismatch/scope/retry/retention");
} finally {
  rmSync(out, { recursive: true, force: true });
}
