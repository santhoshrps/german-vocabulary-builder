#!/usr/bin/env node
// End-to-end integration harness (L6-shaped, local): boots `wrangler dev --local`
// with known local-only secrets (.dev.vars — fixtures, not real), applies
// migrations to the local D1 state, mints sessions with the local JWT secret
// (no backdoors in worker code), and drives the full authed story:
// join ×2 → publish → board/ETag/304 → invite → preview → accept (E18,
// generations) → cheer converge → remove → stale reversal → delete saga →
// status by capability → data gone.
//
// Traceability (L6 disposable-environment lane):
// TS-LB3-ARCH-004 TS-LB3-ARCH-008 TS-LB3-ARCH-009
// TS-LB3-ARCH-010 TS-LB3-DB-001 TS-LB3-DB-002
// TS-LB3-DB-003 TS-LB3-DB-004 TS-LB3-DB-005
// TS-LB3-DB-006 TS-LB3-DB-007 TS-LB3-DB-008
// TS-LB3-DB-009 TS-LB3-DB-010 TS-LB3-DB-012
// TS-LB3-AUTH-005 TS-LB3-AUTH-009 TS-LB3-AUTH-011
// TS-LB3-AUTH-017 TS-LB3-INVITE-002 TS-LB3-INVITE-004
// TS-LB3-INVITE-005 TS-LB3-INVITE-008 TS-LB3-INVITE-009
// TS-LB3-INVITE-011 TS-LB3-INVITE-012 TS-LB3-INVITE-013
// TS-LB3-INVITE-014 TS-LB3-REL-001 TS-LB3-REL-002
// TS-LB3-REL-004 TS-LB3-REL-005 TS-LB3-REL-006
// TS-LB3-REL-007 TS-LB3-REL-008 TS-LB3-REL-009
// TS-LB3-REL-011 TS-LB3-REL-015 TS-LB3-REL-018
// TS-LB3-REL-020 TS-LB3-BOARD-005 TS-LB3-BOARD-006
// TS-LB3-BOARD-009 TS-LB3-BOARD-010 TS-LB3-BOARD-011
// TS-LB3-BOARD-012 TS-LB3-BOARD-014 TS-LB3-BOARD-016
// TS-LB3-BOARD-020 TS-LB3-SYNC-004 TS-LB3-SYNC-006
// TS-LB3-SYNC-011 TS-LB3-SYNC-013 TS-LB3-SYNC-014
// TS-LB3-SYNC-016 TS-LB3-SYNC-017 TS-LB3-SYNC-018
// TS-LB3-ECON-001 TS-LB3-ECON-002 TS-LB3-ECON-003
// TS-LB3-ECON-004 TS-LB3-ECON-005 TS-LB3-ECON-006
// TS-LB3-ECON-007 TS-LB3-ECON-008 TS-LB3-SOCIAL-001
// TS-LB3-SOCIAL-003 TS-LB3-SOCIAL-005 TS-LB3-SOCIAL-014
// TS-LB3-RELY-004 TS-LB3-RELY-005 TS-LB3-RELY-009
// TS-LB3-RELY-011 TS-LB3-DELETE-001 TS-LB3-DELETE-002
// TS-LB3-DELETE-003 TS-LB3-DELETE-004 TS-LB3-DELETE-005
// TS-LB3-DELETE-006 TS-LB3-DELETE-007 TS-LB3-DELETE-008
// TS-LB3-DELETE-009 TS-LB3-DELETE-010 TS-LB3-DELETE-012
// TS-LB3-DELETE-013 TS-LB3-DELETE-014 TS-LB3-SEC-001
// TS-LB3-SEC-002 TS-LB3-SEC-003 TS-LB3-SEC-004
// TS-LB3-SEC-005 TS-LB3-SEC-010 TS-LB3-SEC-011
// TS-LB3-SEC-015 TS-LB3-SEC-016 TS-LB3-SEC-020
// TS-LB3-PERF-002 TS-LB3-PERF-003 TS-LB3-PERF-004.
//
// Run: npm run itest

import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8799;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "local-itest-jwt-secret-not-real";

// --- bundle crypto.ts to mint tokens exactly as the worker verifies them -----
const out = mkdtempSync(join(tmpdir(), "lb-itest-"));
execSync(`npx --prefix ../read-worker esbuild src/crypto.ts --bundle --format=esm --outfile=${join(out, "crypto.mjs")}`,
  { cwd: root, stdio: "pipe" });
const { mintJwt } = await import(join(out, "crypto.mjs"));

async function prejoinSession(hashed) {
  const iat = Math.floor(Date.now() / 1000);
  return mintJwt(JWT_SECRET, {
    sub: `prejoin:apple:1:${hashed}`, aud: "leaderboard", env: "dev",
    sv: 0, fam: crypto.randomUUID(), iat, exp: iat + 900, jti: crypto.randomUUID(),
  });
}

// --- boot the local worker (FRESH local state every run — determinism) --------
rmSync(join(root, ".wrangler", "state"), { recursive: true, force: true });
for (const db of ["german-social-dev", "german-erasure-dev", "german-projection-1-dev"]) {
  execSync(`npx --prefix ../read-worker wrangler d1 migrations apply ${db} --env dev --local`,
    { cwd: root, stdio: "pipe" });
}
const worker = spawn("npx", ["--prefix", "../read-worker", "wrangler", "dev", "--env", "dev", "--local", "--port", String(PORT)],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let workerLog = "";
worker.stdout.on("data", (d) => { workerLog += d; });
worker.stderr.on("data", (d) => { workerLog += d; });

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const h = await fetch(`${URL_BASE}/health`);
      if (h.status === 200) { up = true; break; }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(up, `worker never came up:\n${workerLog.slice(-2000)}`);

  const api = async (method, path, { token, idem, body, headers = {} } = {}) => {
    const res = await fetch(`${URL_BASE}/v3/leaderboard${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idem ? { "idempotency-key": idem } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, etag: res.headers.get("etag"), json: text ? JSON.parse(text) : null };
  };

  // --- join two players ------------------------------------------------------
  const joinAs = async (name, hashed) => {
    const pre = await prejoinSession(hashed);
    const r = await api("POST", "/profile/join", { token: pre, idem: crypto.randomUUID(), body: { nickname: name, tzZone: "Europe/Berlin" } });
    assert.equal(r.json.code, "OK", JSON.stringify(r.json));
    return { id: r.json.data.playerId, session: r.json.data.session, nickname: name };
  };
  const anna = await joinAs("Anna", "a".repeat(64));
  const ben = await joinAs("Ben", "b".repeat(64));
  console.log("✓ join ×2");

  // Idempotent re-join converges
  const rejoin = await api("POST", "/profile/join", { token: await prejoinSession("a".repeat(64)), idem: crypto.randomUUID(), body: { nickname: "Ignored", tzZone: "UTC" } });
  assert.equal(rejoin.json.data.existing, true);
  assert.equal(rejoin.json.data.playerId, anna.id);
  console.log("✓ re-join converges to existing player");

  // --- publish → board -------------------------------------------------------
  const today = Math.floor(Date.now() / 86_400_000);
  const payload = {
    schemaVersion: 1, ruleVersion: 1,
    frontier: { "device-1": 262 },
    days: [{
      day: today, component: "device-1",
      counters: { sessionPts: 240, wordPts: 13, timePts: 4, learnSec: 600, focusSec: 300, sessions: 2, wordsTouched: 20 },
      zone: { ianaZone: "Europe/Berlin", offsetMin: 120 },
      buckets: [
        { deltaQH: 30, sessionPts: 140, wordPts: 13, timePts: 2 },
        { deltaQH: 60, sessionPts: 100, wordPts: 0, timePts: 2 },
      ],
    }],
    awards: [{ kind: "dailyGoal", dedupKey: `dg-${today}`, points: 5, dayLabel: new Date().toISOString().slice(0, 10), bucket: Math.floor(Date.now() / 900_000) }],
    registers: { streak: { v: 4, asOf: new Date().toISOString().slice(0, 10), seq: 1, fam: "device-1" }, mastered: { v: 42, asOf: new Date().toISOString().slice(0, 10), seq: 1, fam: "device-1" } },
  };
  const pub1 = await api("POST", "/publish", { token: anna.session, body: payload });
  assert.equal(pub1.json.code, "OK", JSON.stringify(pub1.json));
  assert.equal(pub1.json.data.changed, true);
  const pub2 = await api("POST", "/publish", { token: anna.session, body: payload });
  assert.equal(pub2.json.data.changed, false, "replay must be a no-op join");
  console.log("✓ publish; replay changed=false (algebraic idempotence)");

  const board1 = await api("GET", "/board", { token: anna.session });
  assert.equal(board1.json.code, "OK");
  assert.equal(board1.json.data.self.weekPts, 262, `weekPts ${board1.json.data.self.weekPts}`);
  assert.equal(board1.json.data.self.streak, 4);
  assert.equal(board1.json.data.self.mastered, 42);
  const board304 = await api("GET", "/board", { token: anna.session, headers: { "if-none-match": board1.etag } });
  assert.equal(board304.status, 304, "ETag must 304");
  console.log("✓ board figures exact (week=262, streak=4, mastered=42); conditional 304");

  // Publish's documented idempotency exception: another device may advance the
  // authoritative frontier between the original request and its replay. The
  // replay must answer CURRENT merged frontier/revision with changed=false.
  const otherDevice = structuredClone(payload);
  otherDevice.frontier = { "device-2": 10 };
  otherDevice.days[0].component = "device-2";
  otherDevice.days[0].counters = {
    sessionPts: 5, wordPts: 0, timePts: 0,
    learnSec: 3, focusSec: 0, sessions: 1, wordsTouched: 1,
  };
  otherDevice.days[0].buckets = [
    { deltaQH: 31, sessionPts: 5, wordPts: 0, timePts: 0 },
  ];
  otherDevice.awards = [];
  otherDevice.registers = undefined;
  const pubOther = await api("POST", "/publish", {
    token: anna.session, body: otherDevice,
  });
  assert.equal(pubOther.json.code, "OK");
  const replayAfterOther = await api("POST", "/publish", {
    token: anna.session, body: payload,
  });
  assert.equal(replayAfterOther.json.data.changed, false);
  assert.deepEqual(replayAfterOther.json.data.frontier, {
    "device-1": 262, "device-2": 10,
  }, "publish replay must return the current merged frontier");
  assert.ok(replayAfterOther.json.data.revision >= pubOther.json.data.revision);
  console.log("✓ publish replay returns current merged multi-device frontier");

  // Envelope refusal
  const over = structuredClone(payload);
  over.days[0].counters.sessionPts = 6001;
  over.days[0].buckets = [];
  const rej = await api("POST", "/publish", { token: anna.session, body: over });
  assert.equal(rej.json.code, "PUBLISH_ENVELOPE_EXCEEDED");
  console.log("✓ envelope violation rejected");

  // --- invite → preview → accept --------------------------------------------
  const inv = await api("POST", "/invites", { token: anna.session, idem: crypto.randomUUID() });
  assert.equal(inv.json.code, "OK");
  const invToken = inv.json.data.link.split("#")[1];
  assert.ok(inv.json.data.link.includes("/german/join#"));
  const preview = await api("POST", "/invites/preview", { body: { token: invToken } });
  assert.equal(preview.json.data.inviterNickname, "Anna");
  const own = await api("POST", "/invites/accept", { token: anna.session, idem: crypto.randomUUID(), body: { token: invToken } });
  assert.equal(own.json.code, "INVITE_OWN");
  const accept = await api("POST", "/invites/accept", { token: ben.session, idem: crypto.randomUUID(), body: { token: invToken } });
  assert.equal(accept.json.code, "OK", JSON.stringify(accept.json));
  assert.equal(accept.json.data.friend.nickname, "Anna");
  assert.ok(accept.json.data.e18?.receiptId, "E18 receipt expected");
  const replayAccept = await api("POST", "/invites/accept", { token: ben.session, idem: crypto.randomUUID(), body: { token: invToken } });
  assert.equal(replayAccept.json.code, "INVITE_CONSUMED");
  console.log("✓ invite → preview names inviter → own-tap no-op → accept links + E18 → replay consumed");

  // E18 finalize: first valid ack wins; bad amount rejected
  const receipts = await api("GET", "/e18/receipts", { token: ben.session });
  const receiptId = receipts.json.data.receipts[0].receiptId;
  const badAck = await api("POST", "/e18/receipts/ack", { token: ben.session, idem: crypto.randomUUID(), body: { receiptId, offeredAmount: 999 } });
  assert.equal(badAck.json.code, "SCHEMA_INVALID");
  const ack = await api("POST", "/e18/receipts/ack", { token: ben.session, idem: crypto.randomUUID(), body: { receiptId, offeredAmount: 150 } });
  assert.equal(ack.json.data.finalizedAmount, 150);
  console.log("✓ E18 ladder validation + finalize");

  // Board shows the friend for both; cheer converges
  const bBoard = await api("GET", "/board", { token: ben.session });
  assert.equal(bBoard.json.data.friends.length, 1);
  assert.equal(bBoard.json.data.friends[0].nickname, "Anna");
  const cheer1 = await api("POST", "/cheers", { token: ben.session, idem: crypto.randomUUID(), body: { playerId: anna.id } });
  assert.equal(cheer1.json.data.already, false);
  const cheer2 = await api("POST", "/cheers", { token: ben.session, idem: crypto.randomUUID(), body: { playerId: anna.id } });
  assert.equal(cheer2.json.data.already, true, "same-day cheer must converge");
  console.log("✓ friend on both boards; cheer converges same-day");

  // Duo receipts: Ben publishes the same local day → both sides minted
  const benPayload = structuredClone(payload);
  benPayload.awards = [];
  const benPub = await api("POST", "/publish", { token: ben.session, body: benPayload });
  assert.equal(benPub.json.code, "OK");
  const bBoard2 = await api("GET", "/board", { token: ben.session });
  assert.ok(bBoard2.json.data.self.duoDays.length >= 1, "duo receipt expected after matching day");
  console.log("✓ duo receipt minted on matching published day");

  // --- RELY-9: remove wins; stale reversal refused ---------------------------
  const remove = await api("POST", "/friends/remove", { token: anna.session, idem: crypto.randomUUID(), body: { playerId: ben.id } });
  assert.equal(remove.json.code, "OK");
  const gen = remove.json.data.generation;
  const staleUnblock = await api("POST", "/blocks/remove", { token: anna.session, idem: crypto.randomUUID(), body: { playerId: ben.id, observedGeneration: gen - 1 } });
  assert.equal(staleUnblock.json.code, "GENERATION_STALE");
  assert.equal(staleUnblock.json.data.currentGeneration, gen);
  const bAfter = await api("GET", "/board", { token: ben.session });
  assert.equal(bAfter.json.data.friends.length, 0, "removed edge must vanish for the removed side too");
  console.log("✓ remove drops edge both sides; stale constructive reversal answers GENERATION_STALE");

  // Idempotency: same key + different body must reject
  const key = crypto.randomUUID();
  await api("POST", "/mutes", { token: anna.session, idem: key, body: { playerId: ben.id } });
  const mismatch = await api("POST", "/mutes", { token: anna.session, idem: key, body: { playerId: anna.id } });
  assert.equal(mismatch.json.code, "IDEMPOTENCY_MISMATCH");
  console.log("✓ idempotency-key mismatch rejected");

  // --- deletion saga ---------------------------------------------------------
  const del = await api("DELETE", "/profile", { token: ben.session, idem: crypto.randomUUID(), body: {} });
  assert.equal(del.status, 202, JSON.stringify(del.json));
  const capability = del.json.data.deletionCapability;
  const status = await api("GET", "/profile/delete-status", { headers: { "x-deletion-capability": capability } });
  assert.ok(["journaled", "erasing", "external", "done"].includes(status.json.data.state), status.json.data.state);
  // The inline best-effort attempt usually completes locally; assert terminal-or-progressing,
  // then that the profile is truly gone:
  const gone = await api("GET", "/profile", { token: ben.session });
  assert.ok(["PROFILE_GONE", "AUTH_EXPIRED", "AUTH_INVALID"].includes(gone.json.code), gone.json.code);
  const annaBoard = await api("GET", "/board", { token: anna.session });
  assert.equal(annaBoard.json.data.friends.length, 0);
  console.log(`✓ deletion: 202 + capability; status=${status.json.data.state}; profile gone; no ghost on friend's board`);

  console.log("\nintegration OK — full authed surface exercised end to end");
} finally {
  worker.kill("SIGTERM");
  rmSync(out, { recursive: true, force: true });
}
