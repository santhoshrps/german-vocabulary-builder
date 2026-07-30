#!/usr/bin/env node
// Invite capability, landing-page and quota tests.
//
// Traceability:
// TS-LB3-INVITE-004 TS-LB3-INVITE-006 TS-LB3-INVITE-007
// TS-LB3-INVITE-008 TS-LB3-INVITE-011 TS-LB3-INVITE-012
// TS-LB3-INVITE-013 TS-LB3-INVITE-014 TS-LB3-INVITE-018
// TS-LB3-SEC-004 TS-LB3-SEC-007 TS-LB3-SEC-010
// TS-LB3-SEC-017 TS-LB3-SEC-019.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "lb-invite-"));

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.first(this.sql, this.args); }
  run() { return this.db.run(this.sql, this.args); }
  all() { return this.db.all(this.sql, this.args); }
}

class InviteD1 {
  constructor() {
    this.invites = new Map();
    this.quotas = new Map();
  }
  prepare(sql) { return new Statement(this, sql); }
  async first(sql, args) {
    if (sql.includes("SELECT tz_zone FROM players")) return { tz_zone: "Europe/Berlin" };
    if (sql.includes("SELECT count(*) AS n FROM invites")) {
      return {
        n: [...this.invites.values()].filter((invite) =>
          invite.inviter === args[0] && invite.state === "pending"
          && invite.expires_at > args[1]).length,
      };
    }
    if (sql.includes("JOIN players p") && sql.includes("WHERE i.token_hash")) {
      const invite = this.invites.get(args[0]);
      return invite ? { ...invite, nickname: "Anna" } : null;
    }
    throw new Error(`unhandled first: ${sql}`);
  }
  async run(sql, args) {
    if (sql.includes("INSERT OR IGNORE INTO quotas")) {
      const key = `${args[0]}|${args[2]}|${args[1]}`;
      if (!this.quotas.has(key)) this.quotas.set(key, 0);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE quotas SET count = count + 1")) {
      const [player, kind, day, limit] = args;
      const key = `${player}|${day}|${kind}`;
      const count = this.quotas.get(key) ?? 0;
      if (count >= limit) return { meta: { changes: 0 } };
      this.quotas.set(key, count + 1);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO invites")) {
      const [hash, inviter, createdAt, expiresAt] = args;
      assert.equal(this.invites.has(hash), false, "invite hash collision");
      this.invites.set(hash, {
        token_hash: hash, inviter, state: "pending",
        created_at: createdAt, expires_at: expiresAt,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE invites SET state = 'withdrawn'")) {
      const [inviter, prefix] = args;
      for (const invite of this.invites.values()) {
        if (invite.inviter === inviter && invite.state === "pending"
          && invite.token_hash.startsWith(prefix)) invite.state = "withdrawn";
      }
      return { meta: { changes: 1 } };
    }
    throw new Error(`unhandled run: ${sql}`);
  }
  async all() { return { results: [] }; }
}

try {
  for (const module of ["social", "index"]) {
    execSync(
      `npx --prefix ../read-worker esbuild src/${module}.ts --bundle --format=esm --outfile=${join(out, `${module}.mjs`)}`,
      { cwd: root, stdio: "pipe" },
    );
  }
  const social = await import(join(out, "social.mjs"));
  const worker = (await import(join(out, "index.mjs"))).default;
  const db = new InviteD1();
  const env = {
    SOCIAL_DB: db, INVITE_LINK_BASE: "https://learn-languages.app/german/join",
    APP_TEAM_ID: "TEAM", APP_BUNDLE_ID: "com.example.app",
  };
  const ctx = {
    playerId: "p1", family: "f1", nickname: "Anna",
    boardRevision: 0, sessionVersion: 1,
  };

  // Exactly ten creations in the profile quota day; withdrawal does not refund.
  const rawTokens = [];
  for (let i = 0; i < 10; i++) {
    const result = await social.handleInviteCreate(
      new Request("https://worker.test/v3/leaderboard/invites", { method: "POST" }),
      env, ctx,
    );
    assert.equal(result.code, "OK");
    const link = new URL(result.data.link);
    assert.equal(link.origin + link.pathname,
      "https://learn-languages.app/german/join");
    assert.equal(link.search, "");
    assert.ok(link.hash.length > 20);
    const token = link.hash.slice(1);
    rawTokens.push(token);
    assert.equal([...db.invites.keys()].some((hash) => hash.includes(token)), false,
      "raw bearer token persisted");
    assert.ok(result.data.expiresAt - Date.now() >= 30 * 86_400_000 - 1_000);
  }
  assert.equal(new Set(rawTokens).size, 10);
  const eleventh = await social.handleInviteCreate(
    new Request("https://worker.test/v3/leaderboard/invites", { method: "POST" }),
    env, ctx,
  );
  assert.equal(eleventh.code, "LIMIT_INVITES_DAY");
  await social.handleInviteWithdraw(
    { inviteId: [...db.invites.keys()][0].slice(0, 16) }, env, ctx,
  );
  const afterWithdrawal = await social.handleInviteCreate(
    new Request("https://worker.test/v3/leaderboard/invites", { method: "POST" }),
    env, ctx,
  );
  assert.equal(afterWithdrawal.code, "LIMIT_INVITES_DAY");

  // Preview is repeatable, minimal and does not consume/reserve.
  const token = rawTokens[1];
  const previewRequest = () => new Request(
    "https://worker.test/v3/leaderboard/invites/preview",
    {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    },
  );
  const p1 = await social.handleInvitePreview(previewRequest(), env);
  const p2 = await social.handleInvitePreview(previewRequest(), env);
  assert.deepEqual(p1, { code: "OK", data: { inviterNickname: "Anna" } });
  assert.deepEqual(p2, p1);
  assert.equal([...db.invites.values()].filter((invite) =>
    invite.state === "pending").length, 9);

  // Landing page never reads/transmits the fragment and ships no third-party
  // bytes. It exposes the exact App Store product through Apple's standard badge
  // and Smart App Banner. The association file permits only the exact join path.
  const landing = await worker.fetch(
    new Request("https://worker.test/german/join"),
    env,
  );
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get("referrer-policy"), "no-referrer");
  assert.equal(landing.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; "
    + "form-action 'none'; frame-ancestors 'none'");
  assert.equal(landing.headers.get("x-frame-options"), "DENY");
  const html = await landing.text();
  assert.doesNotMatch(html, /<script|<img|<iframe|<link|src=/i);
  assert.match(html,
    /<meta name="apple-itunes-app" content="app-id=6786836287">/);
  assert.match(html,
    /href="https:\/\/apps\.apple\.com\/app\/id6786836287"/);
  assert.match(html,
    /aria-label="Download German Vocabulary on the App Store"/);
  assert.match(html, /<svg id="livetype"[^>]+viewBox="0 0 119\.66407 40">/);
  assert.match(html, /Apple and the Apple logo are trademarks of Apple Inc\./);
  assert.match(html, /--cream: #F6F1E6;/);
  assert.match(html, /--red: #C23A2F;/);
  assert.deepEqual([...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
    ["https://apps.apple.com/app/id6786836287"],
    "the App Store badge is the page's only navigation");
  assert.equal(html.includes(rawTokens[0]), false);

  const association = await worker.fetch(
    new Request("https://worker.test/.well-known/apple-app-site-association"),
    env,
  );
  const associationJSON = await association.json();
  assert.deepEqual(associationJSON.applinks.details[0].components,
    [{ "/": "/german/join", comment: "leaderboard invite" }]);

  console.log("invite-policy.test OK — hashed fragment, quota, preview, landing policy");
} finally {
  rmSync(out, { recursive: true, force: true });
}
