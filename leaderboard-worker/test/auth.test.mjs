#!/usr/bin/env node
// Authentication/session behavioral harness with an in-memory D1 seam.
//
// Traceability:
// TS-LB3-AUTH-002 TS-LB3-AUTH-003 TS-LB3-AUTH-004
// TS-LB3-AUTH-005 TS-LB3-AUTH-006 TS-LB3-AUTH-007
// TS-LB3-AUTH-008 TS-LB3-AUTH-009 TS-LB3-AUTH-010
// TS-LB3-AUTH-011 TS-LB3-AUTH-015 TS-LB3-AUTH-017
// TS-LB3-DB-002 TS-LB3-DB-005 TS-LB3-DB-006
// TS-LB3-SEC-003 TS-LB3-SEC-006 TS-LB3-SEC-007
// TS-LB3-SEC-008 TS-LB3-SEC-009.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "lb-auth-"));

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.first(this.sql, this.args); }
  run() { return this.db.run(this.sql, this.args); }
}

class AuthD1 {
  constructor() {
    this.players = new Map();
    this.refresh = new Map();
    this.quotas = new Map();
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  async first(sql, args) {
    if (sql.includes("INSERT INTO quotas")) {
      const key = `${args[0]}|${args[1]}`;
      const count = (this.quotas.get(key) ?? 0) + 1;
      this.quotas.set(key, count);
      return { count };
    }
    if (sql.includes("SELECT count(*) AS n FROM refresh_sessions")) {
      const n = [...this.refresh.values()].filter(
        (row) => row.player_id === args[0] && row.revoked === 0,
      ).length;
      return { n };
    }
    if (sql.includes("FROM refresh_sessions WHERE family")) {
      return this.refresh.get(args[0]) ?? null;
    }
    if (sql.includes("SELECT session_version FROM players")) {
      const player = this.players.get(args[0]);
      return player ? { session_version: player.session_version } : null;
    }
    if (sql.includes("SELECT nickname, board_revision, session_version FROM players")) {
      return this.players.get(args[0]) ?? null;
    }
    throw new Error(`unhandled first: ${sql}`);
  }
  async run(sql, args) {
    if (sql.includes("DELETE FROM refresh_sessions WHERE family IN")) {
      const [playerId, offset] = args;
      const active = [...this.refresh.entries()]
        .filter(([, row]) => row.player_id === playerId && row.revoked === 0)
        .sort((a, b) => (b[1].rotated_at ?? b[1].created_at)
          - (a[1].rotated_at ?? a[1].created_at));
      for (const [family] of active.slice(offset)) this.refresh.delete(family);
      return { meta: { changes: Math.max(0, active.length - offset) } };
    }
    if (sql.includes("INSERT INTO refresh_sessions")) {
      const [family, playerId, hashed, expiresAt, createdAt] = args;
      this.refresh.set(family, {
        family, player_id: playerId, hashed_token: hashed,
        prev_hashed_token: null, rotated_at: null,
        expires_at: expiresAt, revoked: 0, created_at: createdAt,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET prev_hashed_token = hashed_token")) {
      const [nextHash, rotatedAt, expiresAt, family] = args;
      const row = this.refresh.get(family);
      row.prev_hashed_token = row.hashed_token;
      row.hashed_token = nextHash;
      row.rotated_at = rotatedAt;
      row.expires_at = expiresAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET revoked = 1 WHERE family = ? AND player_id = ?")) {
      const row = this.refresh.get(args[0]);
      if (row?.player_id === args[1]) row.revoked = 1;
      return { meta: { changes: row?.player_id === args[1] ? 1 : 0 } };
    }
    if (sql.includes("SET revoked = 1 WHERE family = ?")) {
      const row = this.refresh.get(args[0]);
      if (row) row.revoked = 1;
      return { meta: { changes: row ? 1 : 0 } };
    }
    throw new Error(`unhandled run: ${sql}`);
  }
}

try {
  for (const module of ["auth", "crypto"]) {
    execSync(
      `npx --prefix ../read-worker esbuild src/${module}.ts --bundle --format=esm --outfile=${join(out, `${module}.mjs`)}`,
      { cwd: root, stdio: "pipe" },
    );
  }
  const auth = await import(join(out, "auth.mjs"));
  const cryptoModule = await import(join(out, "crypto.mjs"));
  const db = new AuthD1();
  db.players.set("p1", {
    nickname: "Anna", board_revision: 7, session_version: 3,
  });
  const env = {
    SOCIAL_DB: db, SOCIAL_JWT_SECRET: "test-social-secret",
    IDENTITY_HMAC_KEY_V1: "test-hmac-key", ENV_NAME: "dev",
    APP_BUNDLE_ID: "com.example.app",
  };

  const claims = (overrides = {}) => {
    const iat = Math.floor(Date.now() / 1000);
    return {
      sub: "p1", aud: "leaderboard", env: "dev", sv: 3,
      fam: "family-1", iat, exp: iat + 900, jti: "jti-1",
      ...overrides,
    };
  };
  const requestFor = async (overrides = {}, secret = env.SOCIAL_JWT_SECRET) => {
    const token = await cryptoModule.mintJwt(secret, claims(overrides));
    return new Request("https://worker.test/v3/leaderboard/profile", {
      headers: { authorization: `Bearer ${token}` },
    });
  };

  // JWT actor binding and rejection matrix.
  const valid = await auth.verifySession(await requestFor(), env);
  assert.equal(valid.ok, true);
  assert.equal(valid.ctx.playerId, "p1");
  assert.equal((await auth.verifySession(await requestFor({}, "wrong"), env)).code,
    "AUTH_INVALID");
  assert.equal((await auth.verifySession(await requestFor({ aud: "content" }), env)).code,
    "AUTH_INVALID");
  assert.equal((await auth.verifySession(await requestFor({ env: "prod" }), env)).code,
    "AUTH_INVALID");
  assert.equal((await auth.verifySession(await requestFor({ exp: 1 }), env)).code,
    "AUTH_EXPIRED");
  assert.equal((await auth.verifySession(await requestFor({ sv: 2 }), env)).code,
    "AUTH_EXPIRED");
  assert.equal((await auth.verifySession(await requestFor({ sub: "missing" }), env)).code,
    "PROFILE_GONE");
  assert.equal((await auth.verifySession(await requestFor({
    sub: `prejoin:apple:1:${"a".repeat(64)}`,
  }), env)).code, "AUTH_INVALID");

  // Refresh credential is opaque on the wire and only a hash is stored.
  const issued = await auth.issueSession(env, "p1");
  const [issuedFamily, issuedRaw] = issued.refreshCredential.split(".");
  assert.equal(db.refresh.get(issuedFamily).hashed_token,
    await cryptoModule.sha256Hex(issuedRaw));
  assert.notEqual(db.refresh.get(issuedFamily).hashed_token, issuedRaw);

  // Lost response: replaying the predecessor inside grace must recover the SAME
  // successor, not rotate again and strand the response the client never saw.
  const firstRefresh = await auth.handleRefresh(new Request(
    "https://worker.test/v3/leaderboard/auth/refresh",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
      body: JSON.stringify({ refreshCredential: issued.refreshCredential }),
    },
  ), env);
  assert.equal(firstRefresh.code, "OK");
  const recovered = await auth.handleRefresh(new Request(
    "https://worker.test/v3/leaderboard/auth/refresh",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
      body: JSON.stringify({ refreshCredential: issued.refreshCredential }),
    },
  ), env);
  assert.equal(recovered.code, "OK");
  assert.equal(recovered.data.refreshCredential,
    firstRefresh.data.refreshCredential, "grace retry must return stored successor");

  // Inconsistent old value revokes exactly this family.
  const theft = await auth.handleRefresh(new Request(
    "https://worker.test/v3/leaderboard/auth/refresh",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.2" },
      body: JSON.stringify({ refreshCredential: `${issuedFamily}.attacker-value` }),
    },
  ), env);
  assert.equal(theft.code, "AUTH_REFRESH_REUSED");
  assert.equal(db.refresh.get(issuedFamily).revoked, 1);

  // Ten families are preserved. Number eleven must require explicit management;
  // it may not silently evict an existing device.
  db.refresh.clear();
  for (let i = 0; i < 10; i++) {
    db.refresh.set(`existing-${i}`, {
      family: `existing-${i}`, player_id: "p1", hashed_token: `h${i}`,
      prev_hashed_token: null, rotated_at: null,
      expires_at: Date.now() + 60_000, revoked: 0, created_at: i,
    });
  }
  const beforeFamilies = new Set(db.refresh.keys());
  const eleventh = await auth.issueSession(env, "p1");
  assert.equal(eleventh.requiresDeviceManagement, true);
  assert.deepEqual(new Set(db.refresh.keys()), beforeFamilies,
    "eleventh session silently evicted an active device");

  // Online sign-out revokes only the calling family.
  db.refresh.set("other-family", {
    family: "other-family", player_id: "p1", hashed_token: "h",
    expires_at: Date.now() + 60_000, revoked: 0, created_at: 0,
  });
  await auth.handleSignout(env, {
    playerId: "p1", family: "other-family", nickname: "Anna",
    boardRevision: 7, sessionVersion: 3,
  });
  assert.equal(db.refresh.get("other-family").revoked, 1);
  for (const family of beforeFamilies) assert.equal(db.refresh.get(family).revoked, 0);

  console.log("auth.test OK — JWT matrix, hashed refresh, recovery, family cap, sign-out");
} finally {
  rmSync(out, { recursive: true, force: true });
}
