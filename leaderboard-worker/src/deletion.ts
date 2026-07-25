// W5 — profile deletion (IDENT-5b saga S1–S6), status capability, export, and
// the queue-less outbox executor (NFR-1b: the cron IS the dispatcher).
//
// The journal in ERASURE_DB commits BEFORE any destructive work; the 202 is
// sent only after S1; every later step is idempotent and re-driven by the cron
// until terminal. ERASURE_DB is never restored behind SOCIAL_DB (contract T10).

import { randomToken, sha256Hex } from "./crypto";
import { blobBytes, blobText } from "./blob";
import type { SessionContext } from "./auth";
import type { Env } from "./index";
import type { ErrorCode } from "./contract";

const RECENT_AUTH_MS = 10 * 60_000;          // deletion needs a fresh provider proof
const JOURNAL_RETENTION_MS = 400 * 86_400_000; // ≥ longest recovery source, then expires
const EXECUTOR_BATCH = 10;
const MAX_ATTEMPTS_BEFORE_ALERT = 20;        // visible via outbox age/attempts (DLQ role)

type Result = { code: ErrorCode; data?: unknown };

// --- R10: DELETE /profile — S1 journal-first, then 202 -----------------------

export async function handleDelete(env: Env, ctx: SessionContext): Promise<Result & { status?: number }> {
  // Online-only + recent authentication (RELY-7/IDENT-5b): the session's family
  // must have been minted by a FRESH provider exchange, not a long-lived refresh.
  const family = await env.SOCIAL_DB.prepare(
    "SELECT created_at FROM refresh_sessions WHERE family = ?1 AND player_id = ?2")
    .bind(ctx.family, ctx.playerId).first();
  if (!family || Date.now() - Number(family.created_at) > RECENT_AUTH_MS) {
    return { code: "AUTH_RECENT_REQUIRED" };
  }

  const capability = randomToken(32);
  const capabilityHash = await sha256Hex(capability);
  const t = Date.now();

  // S1 — journal + marker in ERASURE_DB, atomically, BEFORE anything destructive.
  await env.ERASURE_DB.batch([
    env.ERASURE_DB.prepare(
      `INSERT INTO erasure_saga (player_id, state, capability_hash, steps, requested_at, updated_at, expires_at)
       VALUES (?1, 'journaled', ?2, ?3, ?4, ?4, ?5)
       ON CONFLICT (player_id) DO UPDATE SET updated_at = ?4`)
      .bind(ctx.playerId, capabilityHash, new TextEncoder().encode("{}"), t, t + JOURNAL_RETENTION_MS),
    env.ERASURE_DB.prepare(
      `INSERT INTO erasure_markers (player_id, requested_at, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (player_id) DO NOTHING`)
      .bind(ctx.playerId, t, t + JOURNAL_RETENTION_MS),
  ]);

  // S2 — durable dispatch intent (the cron re-drives it until terminal).
  await env.SOCIAL_DB.prepare(
    `INSERT OR IGNORE INTO outbox (dedup_id, kind, payload, due_at, created_at)
     VALUES (?1, 'erasure', ?2, ?3, ?3)`)
    .bind(`erasure:${ctx.playerId}`, new TextEncoder().encode(ctx.playerId), t).run();

  // Session dies with the revocation inside the erasure transaction; the
  // capability keeps the status route honest afterwards. Best-effort inline
  // attempt — the cron is the durability, never this call (RELY-1).
  try { await runErasureStep(env, ctx.playerId); } catch { /* cron re-drives */ }

  return { code: "OK", status: 202, data: { deletionCapability: capability, statusPath: "/v3/leaderboard/profile/delete-status" } };
}

// --- R11: delete-status by capability (works after the session is gone) ------

export async function handleDeleteStatus(request: Request, env: Env): Promise<Result> {
  const token = request.headers.get("x-deletion-capability") ?? "";
  if (!token || token.length > 64) return { code: "AUTH_INVALID" };
  const hash = await sha256Hex(token);
  const saga = await env.ERASURE_DB.prepare(
    "SELECT state, requested_at, updated_at FROM erasure_saga WHERE capability_hash = ?").bind(hash).first();
  if (!saga) return { code: "AUTH_INVALID" };
  return {
    code: "OK",
    data: { state: saga.state, requestedAt: saga.requested_at, updatedAt: saga.updated_at },
  };
}

// --- R9: export (IDENT-8) — the owner-visible inventory rows -----------------

export async function handleExport(env: Env, ctx: SessionContext): Promise<Result> {
  const me = ctx.playerId;
  const [player, edges, invites, cheersOut, cheersIn, receipts, duo, blocks, mutes] = await Promise.all([
    env.SOCIAL_DB.prepare("SELECT nickname, tz_zone, created_at FROM players WHERE player_id = ?").bind(me).first(),
    env.SOCIAL_DB.prepare("SELECT a, b, created_at FROM friendships WHERE a = ?1 OR b = ?1").bind(me).all(),
    env.SOCIAL_DB.prepare("SELECT state, created_at, expires_at FROM invites WHERE inviter = ?").bind(me).all(),
    env.SOCIAL_DB.prepare("SELECT to_player, quota_day FROM cheers WHERE from_player = ?").bind(me).all(),
    env.SOCIAL_DB.prepare("SELECT from_player, quota_day FROM cheers WHERE to_player = ?").bind(me).all(),
    env.SOCIAL_DB.prepare("SELECT receipt_id, tier_ordinal, finalized_amount, created_at FROM e18_receipts WHERE player_id = ?").bind(me).all(),
    env.SOCIAL_DB.prepare("SELECT day_label, rule_version FROM duo_receipts WHERE player_id = ?").bind(me).all(),
    env.SOCIAL_DB.prepare("SELECT target, created_at FROM blocks WHERE owner = ?").bind(me).all(),
    env.SOCIAL_DB.prepare("SELECT target, created_at FROM mutes WHERE owner = ?").bind(me).all(),
  ]);
  const days = await env.PROJECTION_1.prepare(
    "SELECT day_u16, component_id, length(blob) AS bytes FROM day_state WHERE player_id = ?").bind(me).all();
  return {
    code: "OK",
    data: {
      exportedAt: Date.now(),
      profile: { playerId: me, ...player },
      friendships: edges.results, invitesCreated: invites.results,
      cheersSent: cheersOut.results, cheersReceived: cheersIn.results,
      e18Receipts: receipts.results, duoReceipts: duo.results,
      blocks: blocks.results, mutes: mutes.results,
      publishedDayState: days.results,
    },
  };
}

// --- the erasure saga steps (idempotent; re-driven by the cron) --------------

async function sagaState(env: Env, playerId: string, state: string): Promise<void> {
  await env.ERASURE_DB.prepare(
    "UPDATE erasure_saga SET state = ?2, updated_at = ?3 WHERE player_id = ?1")
    .bind(playerId, state, Date.now()).run();
}

export async function runErasureStep(env: Env, playerId: string): Promise<boolean> {
  const saga = await env.ERASURE_DB.prepare(
    "SELECT state FROM erasure_saga WHERE player_id = ?").bind(playerId).first();
  if (!saga || saga.state === "done") return true;

  // S5 first-half: read the revocation credential BEFORE the rows die.
  const credential = await env.SOCIAL_DB.prepare(
    "SELECT revocation FROM credentials WHERE player_id = ?").bind(playerId).first();

  // S3 — SOCIAL_DB erasure transaction: every inventoried row class with a
  // player key (data-inventory.md; moderation reports deliberately retained
  // under their own access-controlled schedule — inventory row 21).
  await sagaState(env, playerId, "erasing");
  await env.SOCIAL_DB.batch([
    env.SOCIAL_DB.prepare("DELETE FROM friendships WHERE a = ?1 OR b = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM pair_state WHERE a = ?1 OR b = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM invites WHERE inviter = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM cheers WHERE from_player = ?1 OR to_player = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM blocks WHERE owner = ?1 OR target = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM mutes WHERE owner = ?1 OR target = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM e18_receipts WHERE player_id = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM e18_pairs WHERE a = ?1 OR b = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM duo_receipts WHERE player_id = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM awards_window WHERE player_id = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM spends WHERE player_id = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM checkpoints WHERE player_id = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM registers WHERE player_id = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM quotas WHERE player_id = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM idempotency WHERE player_id = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM refresh_sessions WHERE player_id = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM credentials WHERE player_id = ?1").bind(playerId),
    env.SOCIAL_DB.prepare("DELETE FROM players WHERE player_id = ?1").bind(playerId),
  ]);

  // S4 — the player's projection shard.
  await env.PROJECTION_1.prepare("DELETE FROM day_state WHERE player_id = ?").bind(playerId).run();

  // S5 — provider revocation (App Store requirement). Runs only when the SIWA
  // key secrets and a stored credential exist; the outcome is recorded either
  // way — "skipped" is a visible state, never a silent hole.
  await sagaState(env, playerId, "external");
  let revocation = "skipped-no-credential";
  const revocationBlob = blobBytes(credential?.revocation);
  if (revocationBlob && env.APPLE_SIWA_KEY_P8 && env.APPLE_SIWA_KEY_ID) {
    try {
      revocation = (await revokeAppleToken(env, revocationBlob)) ? "revoked" : "failed";
    } catch { revocation = "failed"; }
    if (revocation === "failed") return false; // cron retries; attempts counted
  }

  // S6 — terminal: tombstone the journal, complete the marker.
  const t = Date.now();
  await env.ERASURE_DB.batch([
    env.ERASURE_DB.prepare(
      "UPDATE erasure_saga SET state = 'done', steps = ?2, updated_at = ?3 WHERE player_id = ?1")
      .bind(playerId, new TextEncoder().encode(JSON.stringify({ revocation })), t),
    env.ERASURE_DB.prepare(
      "UPDATE erasure_markers SET completed_at = ?2 WHERE player_id = ?1").bind(playerId, t),
  ]);
  return true;
}

/** Apple token revocation: ES256 client-secret JWT signed with the SIWA key. */
async function revokeAppleToken(env: Env, encryptedToken: Uint8Array): Promise<boolean> {
  const token = await decryptRevocation(env, encryptedToken);
  if (!token) return false;
  const now = Math.floor(Date.now() / 1000);
  const header = b64json({ alg: "ES256", kid: env.APPLE_SIWA_KEY_ID });
  const claims = b64json({
    iss: env.APP_TEAM_ID ?? "3VF33Y593F", iat: now, exp: now + 300,
    aud: "https://appleid.apple.com", sub: env.APP_BUNDLE_ID,
  });
  const key = await importP8(env.APPLE_SIWA_KEY_P8!);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`));
  const clientSecret = `${header}.${claims}.${b64url(new Uint8Array(signature))}`;
  const response = await fetch("https://appleid.apple.com/auth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.APP_BUNDLE_ID, client_secret: clientSecret,
      token, token_type_hint: "refresh_token",
    }),
  });
  return response.ok;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function b64json(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function importP8(pem: string): Promise<CryptoKey> {
  const der = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(der), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", raw as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Exchange an Apple authorization code for the refresh token we later revoke
 *  (S5). Gated on the SIWA key secrets; absent secrets → null, recorded as
 *  skipped — never a silent hole. */
export async function appleCodeExchange(env: Env, code: string): Promise<Uint8Array | null> {
  if (!env.APPLE_SIWA_KEY_P8 || !env.APPLE_SIWA_KEY_ID) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = b64json({ alg: "ES256", kid: env.APPLE_SIWA_KEY_ID });
  const claims = b64json({
    iss: env.APP_TEAM_ID ?? "3VF33Y593F", iat: now, exp: now + 300,
    aud: "https://appleid.apple.com", sub: env.APP_BUNDLE_ID,
  });
  const key = await importP8(env.APPLE_SIWA_KEY_P8);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`));
  const response = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.APP_BUNDLE_ID, client_secret: `${header}.${claims}.${b64url(new Uint8Array(signature))}`,
      code, grant_type: "authorization_code",
    }),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { refresh_token?: string };
  return data.refresh_token ? encryptRevocation(env, data.refresh_token) : null;
}

/** AES-GCM under a key derived from the identity secret (inventory row 2:
 *  encrypted, restricted — never a plain row). */
export async function encryptRevocation(env: Env, token: string): Promise<Uint8Array> {
  const key = await revocationKey(env);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(token)));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv); out.set(sealed, 12);
  return out;
}

async function decryptRevocation(env: Env, blob: Uint8Array): Promise<string | null> {
  try {
    const key = await revocationKey(env);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(0, 12) as BufferSource }, key, blob.slice(12) as BufferSource);
    return new TextDecoder().decode(plain);
  } catch { return null; }
}

async function revocationKey(env: Env): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(`revocation|${env.IDENTITY_HMAC_KEY_V1}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// --- the cron executor (queue-less v1: scan → execute → retry with backoff) --

export async function runOutboxTick(env: Env): Promise<void> {
  const now = Date.now();
  const due = await env.SOCIAL_DB.prepare(
    "SELECT dedup_id, kind, payload, attempts FROM outbox WHERE due_at <= ?1 ORDER BY due_at LIMIT ?2")
    .bind(now, EXECUTOR_BATCH).all();
  for (const job of due.results ?? []) {
    const dedupId = String(job.dedup_id);
    let done = false;
    try {
      if (job.kind === "erasure") {
        done = await runErasureStep(env, blobText(job.payload) ?? "");
      } else {
        done = await runCleanup(env);
      }
    } catch (error) {
      console.error(JSON.stringify({ outbox: dedupId, error: String(error) }));
    }
    if (done) {
      await env.SOCIAL_DB.prepare("DELETE FROM outbox WHERE dedup_id = ?").bind(dedupId).run();
    } else {
      const attempts = Number(job.attempts) + 1;
      const backoffMs = Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts, 6));
      await env.SOCIAL_DB.prepare(
        "UPDATE outbox SET attempts = ?2, due_at = ?3 WHERE dedup_id = ?1")
        .bind(dedupId, attempts, now + backoffMs).run();
      if (attempts >= MAX_ATTEMPTS_BEFORE_ALERT) {
        // The DLQ role (queue-less v1): a stuck job is loud, never silent.
        console.error(JSON.stringify({ alert: "outbox-stuck", dedupId, attempts }));
      }
    }
  }
  // Standing cleanup sweeps ride every tick, bounded.
  await runCleanup(env);
}

async function runCleanup(env: Env): Promise<boolean> {
  const now = Date.now();
  await env.SOCIAL_DB.batch([
    env.SOCIAL_DB.prepare("UPDATE invites SET state = 'expired' WHERE state = 'pending' AND expires_at < ?1").bind(now),
    env.SOCIAL_DB.prepare("DELETE FROM nonces WHERE expires_at < ?1").bind(now),
    env.SOCIAL_DB.prepare("DELETE FROM idempotency WHERE expires_at < ?1").bind(now),
    env.SOCIAL_DB.prepare("DELETE FROM refresh_sessions WHERE revoked = 1 AND rotated_at < ?1").bind(now - 30 * 86_400_000),
  ]);
  await env.ERASURE_DB.prepare("DELETE FROM erasure_saga WHERE expires_at < ?1 AND state = 'done'").bind(now).run();
  return true;
}
