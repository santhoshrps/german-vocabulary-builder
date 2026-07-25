#!/usr/bin/env node
// Static/contract gates for the separately deployed leaderboard service.
//
// Traceability:
// TS-LB3-ARCH-003 TS-LB3-ARCH-004 TS-LB3-ARCH-005 TS-LB3-ARCH-006
// TS-LB3-ARCH-007 TS-LB3-ARCH-008 TS-LB3-ARCH-009 TS-LB3-ARCH-010
// TS-LB3-ARCH-011 TS-LB3-DB-001 TS-LB3-DB-008 TS-LB3-DB-010
// TS-LB3-DB-011 TS-LB3-DB-013 TS-LB3-DB-015 TS-LB3-SEC-001
// TS-LB3-SEC-002 TS-LB3-SEC-004 TS-LB3-SEC-005 TS-LB3-SEC-011
// TS-LB3-SEC-013 TS-LB3-SEC-014 TS-LB3-SEC-017 TS-LB3-SEC-018
// TS-LB3-SEC-019
// TS-LB3-OPS-001 TS-LB3-OPS-002 TS-LB3-OPS-004 TS-LB3-OPS-008
// TS-LB3-OPS-009 TS-LB3-OPS-010.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFileSync(join(root, relative), "utf8");
const recursiveFiles = (relative) => {
  const base = join(root, relative);
  const visit = (path) => readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? visit(child) : [child];
  });
  return visit(base);
};

const out = mkdtempSync(join(tmpdir(), "lb-architecture-"));
try {
  execSync(
    `npx --prefix ../read-worker esbuild src/contract.ts --bundle --format=esm --outfile=${join(out, "contract.mjs")}`,
    { cwd: root, stdio: "pipe" },
  );
  const { BASE, ROUTES, ERROR_CODES, SCHEMA_VERSION } =
    await import(join(out, "contract.mjs"));
  const config = read("wrangler.toml");
  const sources = recursiveFiles("src").map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const migrations = recursiveFiles("migrations")
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(file, "utf8")).join("\n");
  const boardSource = read("src/board.ts");
  const socialSource = read("src/social.ts");

  // Separate service, audience, stores and environments.
  assert.match(config, /^name = "german-vocabulary-leaderboard-worker"$/m);
  assert.match(config, /^main = "src\/index\.ts"$/m);
  assert.match(config, /binding = "SOCIAL_DB"/);
  assert.match(config, /binding = "ERASURE_DB"/);
  assert.match(config, /binding = "PROJECTION_1"/);
  assert.match(config, /ENV_NAME = "prod"/);
  assert.match(config, /ENV_NAME = "dev"/);
  assert.doesNotMatch(config, /CONTENT_DB|MEDIA_BUCKET|WORDS_KV/);
  assert.match(sources, /aud:\s*"leaderboard"/);

  // There is no social push machinery or public admin/debug route.
  for (const forbidden of [
    "apns_token", "fcm_token", "push_token", "installation_id",
    "sendPush", "FirebaseMessaging", "CloudKit", "CKRecord",
  ]) {
    assert.ok(!`${sources}\n${migrations}`.toLowerCase()
      .includes(forbidden.toLowerCase()), `forbidden social field: ${forbidden}`);
  }
  assert.equal(ROUTES.some((route) => /admin|debug|moderation|push/i.test(route.path)), false);
  assert.doesNotMatch(boardSource, /moderation_reports/,
    "moderation records must never participate in board joins");
  assert.match(socialSource, /body\.note\.length > 500/);
  assert.doesNotMatch(sources,
    /analytics.*moderation_reports|moderation_reports.*analytics/is);

  // Machine-readable contract: closed namespace, auth, version and stable code set.
  assert.equal(BASE, "/v3/leaderboard");
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(new Set(ROUTES.map((route) => `${route.method} ${route.path}`)).size,
    ROUTES.length);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  for (const route of ROUTES) {
    assert.match(route.id, /^R\d+b?$/);
    assert.ok(route.path.startsWith(BASE));
    assert.ok(["public", "capability", "inviteToken", "session", "sessionIntegrity"]
      .includes(route.auth));
    assert.ok("bodyLimit" in route,
      `${route.id} must declare its body-size policy in the contract`);
    assert.ok("idempotency" in route,
      `${route.id} must declare its idempotency policy in the contract`);
    assert.ok("contentTypes" in route,
      `${route.id} must declare its accepted content types in the contract`);
  }

  // Canonical schema constraints and bounded collections.
  for (const witness of [
    "PRIMARY KEY (provider, key_version, hashed_subject)",
    "CHECK (a < b)",
    "token_hash TEXT PRIMARY KEY",
    "PRIMARY KEY (player_id, kind, dedup_key)",
    "PRIMARY KEY (player_id, route, idem_key)",
    "CHECK (length(blob) <= 1024)",
    "kind IN ('erasure', 'cleanup')",
  ]) {
    assert.ok(migrations.includes(witness), `missing schema invariant: ${witness}`);
  }
  for (const table of [
    "players", "credentials", "refresh_sessions", "registers", "checkpoints",
    "friendships", "pair_state", "invites", "blocks", "mutes", "cheers",
    "e18_pairs", "e18_receipts", "duo_receipts", "awards_window", "spends",
    "idempotency", "quotas", "outbox", "moderation_reports", "nonces",
    "erasure_saga", "erasure_markers", "day_state",
  ]) {
    assert.match(migrations, new RegExp(`CREATE TABLE ${table}\\b`),
      `inventory table ${table} absent`);
  }

  // Forward migrations are numeric and never edit an earlier file in place.
  for (const directory of ["social", "projection", "erasure"]) {
    const names = readdirSync(join(root, "migrations", directory)).sort();
    assert.ok(names.length > 0);
    assert.equal(new Set(names).size, names.length);
    names.forEach((name, index) => {
      assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/);
      if (index > 0) assert.ok(name > names[index - 1]);
    });
  }

  console.log("architecture.test OK — service/config/contract/schema gates");
} finally {
  rmSync(out, { recursive: true, force: true });
}
