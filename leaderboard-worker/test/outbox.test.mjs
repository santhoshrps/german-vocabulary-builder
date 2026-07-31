#!/usr/bin/env node
// Queue contract and at-least-once state-machine tests.
//
// Traceability:
// TS-LB3-DB-010 TS-LB3-DB-011 TS-LB3-DB-014
// TS-LB3-DELETE-003 TS-LB3-OPS-001 TS-LB3-OPS-002
// TS-LB3-PERF-007.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "lb-outbox-"));

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, " ").trim(); this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.first(this.sql, this.args); }
  all() { return this.db.all(this.sql, this.args); }
  run() { return this.db.run(this.sql, this.args); }
}

class FakeSocialDB {
  constructor(rows = []) {
    this.rows = new Map(rows.map((row) => [row.dedup_id, { ...row }]));
    this.throwDispatchStateOnce = false;
    this.reads = 0;
  }
  prepare(sql) { return new FakeStatement(this, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  first(sql, args) {
    this.reads += 1;
    if (sql.includes("FROM outbox WHERE dedup_id")) {
      const row = this.rows.get(args[0]);
      return Promise.resolve(row ? { ...row } : null);
    }
    throw new Error(`unexpected first: ${sql}`);
  }
  all(sql, args) {
    if (sql.includes("FROM outbox") && sql.includes("ORDER BY CASE kind")) {
      const now = Number(args[0]);
      const limit = Number(args[1]);
      const rows = [...this.rows.values()]
        .filter((row) => row.completed_at == null && row.due_at <= now &&
          (row.dispatch_lease_until == null || row.dispatch_lease_until <= now) &&
          (row.processing_lease_until == null || row.processing_lease_until <= now))
        .sort((a, b) => a.due_at - b.due_at)
        .slice(0, limit).map((row) => ({ ...row }));
      return Promise.resolve({ results: rows });
    }
    throw new Error(`unexpected all: ${sql}`);
  }
  run(sql, args) {
    const row = this.rows.get(args[0]);
    if (sql.startsWith("INSERT OR IGNORE INTO outbox") && sql.includes("FROM outbox")) {
      if (row && !this.rows.has(args[1])) {
        this.rows.set(args[1], { ...row, dedup_id: args[1] });
        return Promise.resolve({ meta: { changes: 1 } });
      }
      return Promise.resolve({ meta: { changes: 0 } });
    }
    if (sql === "DELETE FROM outbox WHERE dedup_id = ?1") {
      return Promise.resolve({ meta: { changes: this.rows.delete(args[0]) ? 1 : 0 } });
    }
    if (sql.includes("SET processing_lease_until")) {
      const now = Number(args[2]);
      if (!row || row.completed_at != null ||
          (row.processing_lease_until != null && row.processing_lease_until > now)) {
        return Promise.resolve({ meta: { changes: 0 } });
      }
      row.processing_lease_until = Number(args[1]);
      row.last_attempt_at = now;
      return Promise.resolve({ meta: { changes: 1 } });
    }
    if (sql.includes("SET completed_at")) {
      if (!row || row.completed_at != null) return Promise.resolve({ meta: { changes: 0 } });
      row.completed_at = Number(args[1]);
      row.processing_lease_until = null;
      row.dispatch_lease_until = null;
      row.last_error_code = args[2] ?? null;
      return Promise.resolve({ meta: { changes: 1 } });
    }
    if (sql.includes("SET attempts = attempts + 1")) {
      row.attempts = Number(row.attempts ?? 0) + 1;
      row.due_at = Number(args[1]);
      row.processing_lease_until = null;
      row.dispatch_lease_until = Number(args[2]);
      row.last_attempt_at = Number(args[3]);
      row.last_error_code = args[4];
      return Promise.resolve({ meta: { changes: 1 } });
    }
    if (sql.includes("SET dispatched_at")) {
      if (this.throwDispatchStateOnce) {
        this.throwDispatchStateOnce = false;
        return Promise.reject(new Error("injected lost dispatch write"));
      }
      row.dispatched_at = Number(args[1]);
      row.dispatch_lease_until = Number(args[2]);
      row.dispatch_failures = 0;
      row.last_error_code = null;
      return Promise.resolve({ meta: { changes: 1 } });
    }
    if (sql.includes("SET dispatch_failures = dispatch_failures + 1")) {
      row.dispatch_failures = Number(row.dispatch_failures ?? 0) + 1;
      row.due_at = Number(args[1]);
      row.last_attempt_at = Number(args[2]);
      row.last_error_code = args[3];
      return Promise.resolve({ meta: { changes: 1 } });
    }
    throw new Error(`unexpected run: ${sql}`);
  }
}

function queueMessage(body, attempts = 1) {
  return {
    body, attempts, acked: false, retried: false, delay: null,
    ack() { this.acked = true; },
    retry(options = {}) { this.retried = true; this.delay = options.delaySeconds ?? null; },
  };
}

try {
  execSync(
    `npx --prefix ../read-worker esbuild src/outbox.ts --bundle --format=esm --outfile=${join(out, "outbox.mjs")}`,
    { cwd: root, stdio: "pipe" },
  );
  const worker = await import(join(out, "outbox.mjs"));
  const config = readFileSync(join(root, "wrangler.toml"), "utf8");
  const source = readFileSync(join(root, "src/outbox.ts"), "utf8");
  const contractSource = readFileSync(join(root, "src/outbox-contract.ts"), "utf8");
  const indexSource = readFileSync(join(root, "src/index.ts"), "utf8");

  const secret = "test-only-identity-secret";
  const playerId = "player-identifier-must-not-leave-d1";
  const dedup = await worker.erasureDedupId(secret, playerId);
  assert.match(dedup, /^erasure:[a-f0-9]{64}$/);
  assert.equal(dedup.includes(playerId), false);
  assert.equal(await worker.erasureDedupId(secret, playerId), dedup);
  const valid = worker.makeOutboxMessage("dev", "german", dedup, "erasure");
  assert.deepEqual(worker.parseOutboxMessage(valid), valid);
  for (const malformed of [
    null,
    { ...valid, v: 2 },
    { ...valid, kind: "publish" },
    { ...valid, env: "DEV" },
    { ...valid, dedupId: `erasure:${playerId}` },
    { ...valid, extra: true },
  ]) assert.equal(worker.parseOutboxMessage(malformed), null);
  assert.equal(worker.retryDelaySeconds(dedup, 3), worker.retryDelaySeconds(dedup, 3));
  assert.ok(worker.retryDelaySeconds(dedup, 100) <= 3_600);
  assert.match(contractSource, /OUTBOX_ACTIVE_CAP = 2_000/);
  assert.match(contractSource, /OUTBOX_ERASURE_ACTIVE_CAP = 1_900/);
  assert.match(contractSource, /OUTBOX_CLEANUP_ACTIVE_CAP = 100/);

  const now = 1_000_000;
  const baseRow = {
    dedup_id: dedup, kind: "erasure", payload: new TextEncoder().encode(playerId),
    due_at: now, created_at: now, attempts: 0, dispatch_failures: 0,
    dispatch_lease_until: null, processing_lease_until: null, completed_at: null,
  };
  const social = new FakeSocialDB([baseRow]);
  const env = {
    SOCIAL_DB: social, ENV_NAME: "dev", APP_SLUG: "german",
    SOCIAL_OUTBOX_QUEUE: "german-social-outbox-dev",
    IDENTITY_HMAC_KEY_V1: secret,
  };
  let effects = 0;
  const execute = async () => { effects += 1; return true; };
  const first = await worker.processOutboxMessage(env, valid, 1, execute, now);
  assert.deepEqual(first, { action: "ack", outcome: "completed" });
  const replay = await worker.processOutboxMessage(env, valid, 2, execute, now + 1);
  assert.deepEqual(replay, { action: "ack", outcome: "duplicate-complete" });
  assert.equal(effects, 1, "lost acknowledgement replay must not repeat the effect");

  const failedRow = { ...baseRow, dedup_id: await worker.erasureDedupId(secret, "second") };
  const failedDb = new FakeSocialDB([failedRow]);
  const failedEnv = { ...env, SOCIAL_DB: failedDb };
  const failedMessage = worker.makeOutboxMessage("dev", "german", failedRow.dedup_id, "erasure");
  const retry = await worker.processOutboxMessage(
    failedEnv, failedMessage, 1, async () => false, now,
  );
  assert.equal(retry.action, "retry");
  assert.equal(failedDb.rows.get(failedRow.dedup_id).attempts, 1);
  assert.equal(failedDb.rows.get(failedRow.dedup_id).completed_at, null);

  const lockedRow = {
    ...baseRow, dedup_id: await worker.erasureDedupId(secret, "locked"),
    processing_lease_until: now + 60_000,
  };
  const lockedDb = new FakeSocialDB([lockedRow]);
  let lockedEffects = 0;
  const locked = await worker.processOutboxMessage(
    { ...env, SOCIAL_DB: lockedDb },
    worker.makeOutboxMessage("dev", "german", lockedRow.dedup_id, "erasure"),
    1, async () => { lockedEffects += 1; return true; }, now,
  );
  assert.equal(locked.outcome, "processing-lease-held");
  assert.equal(lockedEffects, 0);

  const poison = queueMessage({ ...valid, v: 99 });
  const goodRow = { ...baseRow, dedup_id: await worker.erasureDedupId(secret, "good") };
  const good = queueMessage(worker.makeOutboxMessage("dev", "german", goodRow.dedup_id, "erasure"));
  const batchDb = new FakeSocialDB([goodRow]);
  await worker.consumeOutboxBatch({
    queue: "german-social-outbox-dev",
    messages: [poison, good],
  }, { ...env, SOCIAL_DB: batchDb }, async () => true);
  assert.equal(poison.retried, true, "poison must travel toward the DLQ");
  assert.equal(good.acked, true, "poison must not block an unrelated valid job");

  const orderedA = { ...baseRow, dedup_id: await worker.erasureDedupId(secret, "order-a") };
  const orderedB = { ...baseRow, dedup_id: await worker.erasureDedupId(secret, "order-b") };
  const reorderedDb = new FakeSocialDB([orderedA, orderedB]);
  const messageA = queueMessage(worker.makeOutboxMessage(
    "dev", "german", orderedA.dedup_id, "erasure",
  ));
  const messageB = queueMessage(worker.makeOutboxMessage(
    "dev", "german", orderedB.dedup_id, "erasure",
  ));
  const executionOrder = [];
  await worker.consumeOutboxBatch({
    queue: "german-social-outbox-dev",
    messages: [messageB, messageA],
  }, { ...env, SOCIAL_DB: reorderedDb }, async (_env, row) => {
    executionOrder.push(row.dedup_id);
    return true;
  });
  assert.deepEqual(executionOrder, [orderedB.dedup_id, orderedA.dedup_id]);
  assert.equal(messageA.acked && messageB.acked, true,
    "independent jobs must complete safely in either delivery order");

  const wrongQueueMessage = queueMessage(valid);
  await worker.consumeOutboxBatch({
    queue: "german-social-outbox-prod",
    messages: [wrongQueueMessage],
  }, env);
  assert.equal(wrongQueueMessage.retried, true);

  const dispatchDb = new FakeSocialDB([{ ...baseRow }]);
  const sent = [];
  const dispatchEnv = {
    ...env,
    SOCIAL_DB: dispatchDb,
    SOCIAL_OUTBOX: {
      async send(body) { sent.push(body); return { metadata: { metrics: {
        backlogCount: 1, backlogBytes: 100,
      } } }; },
    },
  };
  assert.equal(await worker.dispatchDueOutboxes(dispatchEnv, now), 1);
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(sent[0]).includes(playerId), false);
  assert.equal(dispatchDb.rows.get(dedup).completed_at, null,
    "Queue acceptance must not mark terminal completion");
  assert.ok(dispatchDb.rows.get(dedup).dispatch_lease_until > now);

  // A row left by the superseded direct executor used the raw player id in its
  // key. It is transactionally rewritten to the opaque contract before send.
  const legacyId = `erasure:${playerId}`;
  const legacyDb = new FakeSocialDB([{ ...baseRow, dedup_id: legacyId }]);
  const legacySent = [];
  const legacyEnv = {
    ...dispatchEnv, SOCIAL_DB: legacyDb,
    SOCIAL_OUTBOX: {
      async send(body) {
        legacySent.push(body);
        return { metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } } };
      },
    },
  };
  assert.equal(await worker.dispatchDueOutboxes(legacyEnv, now), 1);
  assert.equal(legacyDb.rows.has(legacyId), false);
  assert.equal(legacyDb.rows.has(dedup), true);
  assert.equal(JSON.stringify(legacySent[0]).includes(playerId), false);

  // Send accepted, D1 lease write lost: the unchanged/re-due D1 row recreates
  // the same opaque message later. This is intentionally a safe duplicate.
  const lostWriteDb = new FakeSocialDB([{ ...baseRow }]);
  lostWriteDb.throwDispatchStateOnce = true;
  let accepted = 0;
  const lostWriteEnv = {
    ...dispatchEnv, SOCIAL_DB: lostWriteDb,
    SOCIAL_OUTBOX: { async send() { accepted += 1; return { metadata: { metrics: {
      backlogCount: accepted, backlogBytes: 100,
    } } }; } },
  };
  assert.equal(await worker.dispatchDueOutboxes(lostWriteEnv, now), 0);
  assert.equal(lostWriteDb.rows.get(dedup).last_error_code, "dispatch_state_write");
  assert.equal(await worker.dispatchDueOutboxes(lostWriteEnv, now + 4_000_000), 1);
  assert.equal(accepted, 2);
  assert.equal(lostWriteDb.rows.get(dedup).completed_at, null);

  const outageDb = new FakeSocialDB([{ ...baseRow }]);
  const outageEnv = {
    ...dispatchEnv, SOCIAL_DB: outageDb,
    SOCIAL_OUTBOX: { async send() { throw new Error("queue unavailable"); } },
  };
  assert.equal(await worker.dispatchDueOutboxes(outageEnv, now), 0);
  assert.equal(outageDb.rows.get(dedup).completed_at, null);
  assert.equal(outageDb.rows.get(dedup).last_error_code, "queue_send");
  assert.equal(await worker.dispatchDueOutboxes(outageEnv, now + 90_000_000), 0,
    "D1 must still own work after more than Free Queue retention");

  // Configuration parity and no hidden direct executor.
  for (const suffix of ["dev", "prod"]) {
    assert.match(config, new RegExp(`queue = "german-social-outbox-${suffix}"`));
    assert.match(config, new RegExp(`dead_letter_queue = "german-social-outbox-dlq-${suffix}"`));
  }
  assert.equal((config.match(/binding = "SOCIAL_OUTBOX"/g) ?? []).length, 2);
  assert.equal((config.match(/max_batch_size = 5/g) ?? []).length, 2);
  assert.equal((config.match(/max_concurrency = 2/g) ?? []).length, 2);
  assert.match(indexSource, /async queue\(batch: MessageBatch<unknown>/);
  assert.match(indexSource, /runOutboxMaintenance/);
  assert.doesNotMatch(indexSource, /runOutboxTick|runErasureStep/);
  assert.doesNotMatch(source, /neutralLog\([^\n;]*dedupId/);
  assert.match(source, /recoverJournalOutboxes/);
  assert.match(source, /ORDER BY coalesce\(outbox_checked_at, 0\), requested_at/,
    "journal recovery must rotate fairly instead of rescanning the same first page");

  console.log("outbox.test OK — closed schema, isolation, duplicate/retry, poison, handoff recovery");
} finally {
  rmSync(out, { recursive: true, force: true });
}
