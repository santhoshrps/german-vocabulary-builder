#!/usr/bin/env node
// Erasure policy, inventory and cryptographic-storage tests.
//
// Traceability:
// TS-LB3-DB-010 TS-LB3-DB-011 TS-LB3-DB-013 TS-LB3-DB-014
// TS-LB3-DELETE-001 TS-LB3-DELETE-002 TS-LB3-DELETE-003
// TS-LB3-DELETE-004 TS-LB3-DELETE-005 TS-LB3-DELETE-006
// TS-LB3-DELETE-007 TS-LB3-DELETE-008 TS-LB3-DELETE-009
// TS-LB3-DELETE-010 TS-LB3-DELETE-011 TS-LB3-DELETE-012
// TS-LB3-DELETE-013 TS-LB3-DELETE-014 TS-LB3-DELETE-015
// TS-LB3-OPS-003 TS-LB3-OPS-005 TS-LB3-OPS-006.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "lb-deletion-"));
try {
  execSync(
    `npx --prefix ../read-worker esbuild src/deletion.ts --bundle --format=esm --outfile=${join(out, "deletion.mjs")}`,
    { cwd: root, stdio: "pipe" },
  );
  const deletion = await import(join(out, "deletion.mjs"));
  const source = readFileSync(join(root, "src/deletion.ts"), "utf8");
  const outboxSource = readFileSync(join(root, "src/outbox.ts"), "utf8");
  const erasureSchema = readFileSync(
    join(root, "migrations/erasure/0001_init.sql"), "utf8",
  ) + readFileSync(join(root, "migrations/erasure/0002_queue_recovery.sql"), "utf8");
  const socialSchema = readFileSync(
    join(root, "migrations/social/0001_init.sql"), "utf8",
  ) + readFileSync(join(root, "migrations/social/0004_queue_dispatch.sql"), "utf8");

  // Provider revocation credentials are randomized authenticated ciphertext.
  const env = { IDENTITY_HMAC_KEY_V1: "test-only-identity-secret" };
  const first = await deletion.encryptRevocation(env, "provider-refresh-token");
  const second = await deletion.encryptRevocation(env, "provider-refresh-token");
  assert.ok(first.byteLength > "provider-refresh-token".length);
  assert.notDeepEqual(first, second, "AES-GCM IV must randomize equal plaintext");
  assert.equal(new TextDecoder().decode(first).includes("provider-refresh-token"), false);

  // Journal + marker are in the separate erasure store and appear before any
  // destructive live-data statement in the call path.
  const journalAt = source.indexOf("INSERT INTO erasure_saga");
  const markerAt = source.indexOf("INSERT INTO erasure_markers");
  const dispatchAt = source.indexOf("INSERT OR IGNORE INTO outbox");
  const destructiveAt = source.indexOf("DELETE FROM friendships");
  assert.ok(journalAt >= 0 && markerAt > journalAt);
  assert.ok(dispatchAt > markerAt);
  assert.ok(destructiveAt > dispatchAt);
  assert.match(erasureSchema, /capability_hash TEXT NOT NULL/);
  assert.match(erasureSchema, /erasure_markers/);
  assert.match(erasureSchema, /expires_at INTEGER NOT NULL/);
  assert.match(erasureSchema, /ADD COLUMN revocation BLOB/);
  assert.match(erasureSchema, /ADD COLUMN outbox_checked_at INTEGER/);
  assert.match(erasureSchema, /idx_saga_outbox_recovery/);
  assert.match(source, /revocation = coalesce\(excluded\.revocation, erasure_saga\.revocation\)/);
  assert.match(source, /SET state = 'done'.*revocation = NULL/s,
    "terminal erasure must drop the journaled provider credential");

  // The status capability is random, only its hash persists, expiry participates
  // in authorization and request-rate admission is bounded.
  assert.match(source, /randomToken\(32\)/);
  assert.match(source, /sha256Hex\(capability\)/);
  assert.match(source, /capability_hash = excluded\.capability_hash/,
    "a repeated request must return a capability whose hash was actually stored");
  assert.doesNotMatch(source, /deletionCapability:\s*capabilityHash/);
  const statusStart = source.indexOf("export async function handleDeleteStatus");
  const statusEnd = source.indexOf("// --- R9:", statusStart);
  const status = source.slice(statusStart, statusEnd);
  assert.match(status, /expires_at/);
  assert.match(status, /RATE_LIMITED|quota/i);

  // Every canonical player-bearing collection has an erasure statement. Some
  // need both ownership directions (for example inviter and consumed_by).
  const requiredDeletes = [
    "friendships", "pair_state", "invites", "cheers", "blocks", "mutes",
    "e18_receipts", "e18_pairs", "duo_receipts", "awards_window", "spends",
    "checkpoints", "registers", "quotas", "idempotency", "refresh_sessions",
    "credentials", "players",
  ];
  for (const table of requiredDeletes) {
    assert.match(source, new RegExp(`DELETE FROM ${table}\\b`),
      `erasure misses ${table}`);
  }
  assert.match(source, /DELETE FROM invites WHERE inviter = \?1 OR consumed_by = \?1/,
    "accepted invites retain a deleted player's consumed_by identifier");
  assert.match(source, /DELETE FROM moderation_reports|UPDATE moderation_reports SET reporter/,
    "moderation retention needs declared deidentification");
  assert.match(source, /DELETE FROM day_state WHERE player_id/);

  // Queue is limited to cleanup/erasure, coalesced by opaque dedup key and
  // remains durable in D1 through terminal consumer completion.
  assert.match(socialSchema, /kind IN \('erasure', 'cleanup'\)/);
  for (const field of [
    "dispatched_at", "dispatch_lease_until", "processing_lease_until",
    "last_error_code", "completed_at",
  ]) assert.match(socialSchema, new RegExp(field));
  assert.match(source, /erasureDedupId/);
  assert.doesNotMatch(source, /`erasure:\$\{ctx\.playerId\}`/);
  assert.doesNotMatch(source, /runErasureStep\(env, ctx\.playerId\)/,
    "request path must not execute the destructive saga inline");
  assert.match(outboxSource, /SOCIAL_OUTBOX\.send/);
  assert.match(outboxSource, /message\.ack\(\)/);
  assert.match(outboxSource, /message\.retry/);
  assert.match(outboxSource, /LIMIT \?2/g,
    "every standing cleanup must be page-bounded");
  assert.doesNotMatch(outboxSource, /neutralLog\([^\n;]*dedupId/,
    "logs must not contain stable identifiers");

  // Restore-safety markers and terminal journal age together.
  assert.match(source, /state = 'done'/);
  assert.match(source, /completed_at/);
  assert.match(outboxSource, /DELETE FROM erasure_saga WHERE player_id IN/);

  console.log("deletion.test OK — crypto, journal order, Queue handoff, inventory, cleanup bounds");
} finally {
  rmSync(out, { recursive: true, force: true });
}
