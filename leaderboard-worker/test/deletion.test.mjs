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
  const erasureSchema = readFileSync(
    join(root, "migrations/erasure/0001_init.sql"), "utf8",
  );
  const socialSchema = readFileSync(
    join(root, "migrations/social/0001_init.sql"), "utf8",
  );

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

  // The status capability is random, only its hash persists, expiry participates
  // in authorization and request-rate admission is bounded.
  assert.match(source, /randomToken\(32\)/);
  assert.match(source, /sha256Hex\(capability\)/);
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

  // Queue is limited to cleanup/erasure, coalesced by dedup key and retries with
  // a ceiling. Cleanup work itself must be chunk-bounded.
  assert.match(socialSchema, /kind IN \('erasure', 'cleanup'\)/);
  assert.match(source, /Math\.min\(3_600_000/);
  assert.match(source, /outbox-stuck/);
  assert.match(source, /LIMIT \?/,
    "standing cleanup must be bounded; whole-table sweeps can monopolize D1");

  // Restore-safety markers and terminal journal age together.
  assert.match(source, /state = 'done'/);
  assert.match(source, /completed_at/);
  assert.match(source, /DELETE FROM erasure_saga WHERE expires_at < \?1 AND state = 'done'/);

  console.log("deletion.test OK — crypto, journal order, inventory, status, cleanup bounds");
} finally {
  rmSync(out, { recursive: true, force: true });
}
