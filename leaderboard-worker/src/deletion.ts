// W5 — profile deletion (IDENT-5b saga S1–S6), status capability and export.
//
// The journal in ERASURE_DB commits BEFORE any destructive work; the 202 is
// sent only after S1; every later step is idempotent and re-driven by the Queue
// consumer until terminal. ERASURE_DB is never restored behind SOCIAL_DB
// (contract T10).

import { randomToken, sha256Hex } from "./crypto";
import { blobBytes } from "./blob";
import type { SessionContext } from "./auth";
import type { Env } from "./index";
import type { ErrorCode } from "./contract";
import {
  erasureDedupId, OUTBOX_ACTIVE_CAP, OUTBOX_ERASURE_ACTIVE_CAP,
} from "./outbox-contract";

const RECENT_AUTH_MS = 10 * 60_000;          // deletion needs a fresh provider proof
const JOURNAL_RETENTION_MS = 400 * 86_400_000; // ≥ longest recovery source, then expires
const DELETE_STATUS_PER_HOUR = 30;           // bounds capability-hash probing on the status route

type Result = { code: ErrorCode; data?: unknown };
type DeleteResult = Result & { status?: number; dispatchDedupId?: string };

// --- R10: DELETE /profile — S1 journal-first, then 202 -----------------------

export async function handleDelete(env: Env, ctx: SessionContext): Promise<DeleteResult> {
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
  // Copy the already-encrypted provider credential into the stronger journal
  // before SOCIAL_DB deletion. A crash after S3 can then still finish S5.
  const credential = await env.SOCIAL_DB.prepare(
    "SELECT revocation FROM credentials WHERE player_id = ?1").bind(ctx.playerId).first();
  const encryptedRevocation = blobBytes(credential?.revocation);

  // S1 — journal + marker in ERASURE_DB, atomically, BEFORE anything destructive.
  await env.ERASURE_DB.batch([
    env.ERASURE_DB.prepare(
      `INSERT INTO erasure_saga
         (player_id, state, capability_hash, steps, requested_at, updated_at, expires_at, revocation)
       VALUES (?1, 'journaled', ?2, ?3, ?4, ?4, ?5, ?6)
       ON CONFLICT (player_id) DO UPDATE SET
         capability_hash = excluded.capability_hash,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at,
         revocation = coalesce(excluded.revocation, erasure_saga.revocation)`)
      .bind(
        ctx.playerId, capabilityHash, new TextEncoder().encode("{}"),
        t, t + JOURNAL_RETENTION_MS, encryptedRevocation,
      ),
    env.ERASURE_DB.prepare(
      `INSERT INTO erasure_markers (player_id, requested_at, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (player_id) DO UPDATE SET expires_at = excluded.expires_at`)
      .bind(ctx.playerId, t, t + JOURNAL_RETENTION_MS),
  ]);

  // S2 — bounded durable dispatch intent. If SOCIAL_DB is temporarily
  // unavailable or at its active cap, S1 still owns the obligation and the
  // scheduled journal recovery recreates this exact opaque deduplication id.
  const dispatchDedupId = await erasureDedupId(env.IDENTITY_HMAC_KEY_V1, ctx.playerId);
  try {
    await env.SOCIAL_DB.prepare(
      `INSERT OR IGNORE INTO outbox (dedup_id, kind, payload, due_at, created_at)
       SELECT ?1, 'erasure', ?2, ?3, ?3
       WHERE (SELECT count(*) FROM outbox WHERE completed_at IS NULL) < ?4
         AND (SELECT count(*) FROM outbox
              WHERE completed_at IS NULL AND kind = 'erasure') < ?5`)
      .bind(
        dispatchDedupId, new TextEncoder().encode(ctx.playerId),
        t, OUTBOX_ACTIVE_CAP, OUTBOX_ERASURE_ACTIVE_CAP,
      ).run();
    await env.ERASURE_DB.prepare(
      "UPDATE erasure_saga SET outbox_checked_at = ?2 WHERE player_id = ?1")
      .bind(ctx.playerId, t).run();
  } catch {
    // Never leak the identifier or payload. S1 is durable and stronger than S2.
    console.error(JSON.stringify({ component: "social-outbox", outcome: "s2-write-failed", kind: "erasure" }));
  }

  return {
    code: "OK",
    status: 202,
    dispatchDedupId,
    data: {
      deletionCapability: capability,
      statusPath: "/v3/leaderboard/profile/delete-status",
    },
  };
}

// --- R11: delete-status by capability (works after the session is gone) ------

export async function handleDeleteStatus(request: Request, env: Env): Promise<Result> {
  const token = request.headers.get("x-deletion-capability") ?? "";
  if (!token || token.length > 64) return { code: "AUTH_INVALID" };
  const hash = await sha256Hex(token);
  // Bounded admission: the status route authenticates ONLY by capability hash,
  // so attempts per hash per hour are capped — brute-forcing the opaque
  // capability space is shed here before any erasure-store read (audit).
  const hourWindow = new Date().toISOString().slice(0, 13);
  const taken = await env.SOCIAL_DB.prepare(
    `INSERT INTO quotas (player_id, kind, quota_day, count) VALUES (?1, 'delete_status', ?2, 1)
     ON CONFLICT (player_id, kind, quota_day) DO UPDATE SET count = count + 1
     RETURNING count`).bind(hash, hourWindow).first();
  if (Number(taken?.count ?? 0) > DELETE_STATUS_PER_HOUR) return { code: "RATE_LIMITED" };
  const saga = await env.ERASURE_DB.prepare(
    "SELECT state, requested_at, updated_at, expires_at FROM erasure_saga WHERE capability_hash = ?").bind(hash).first();
  if (!saga) return { code: "AUTH_INVALID" };
  // Expiry participates in authorization: once the journal has aged past its
  // retention the capability proves nothing (the saga is sweep-eligible) — the
  // caller is told it expired rather than shown a stale terminal state.
  if (Number(saga.expires_at) < Date.now()) return { code: "AUTH_EXPIRED" };
  return {
    code: "OK",
    data: {
      state: saga.state, requestedAt: saga.requested_at,
      updatedAt: saga.updated_at, expiresAt: saga.expires_at,
    },
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

// --- the erasure saga steps (idempotent; re-driven by the Queue consumer) ----

async function sagaState(env: Env, playerId: string, state: string): Promise<void> {
  await env.ERASURE_DB.prepare(
    "UPDATE erasure_saga SET state = ?2, updated_at = ?3 WHERE player_id = ?1")
    .bind(playerId, state, Date.now()).run();
}

export async function runErasureStep(env: Env, playerId: string): Promise<boolean> {
  const saga = await env.ERASURE_DB.prepare(
    "SELECT state, revocation FROM erasure_saga WHERE player_id = ?").bind(playerId).first();
  if (!saga || saga.state === "done") return true;

  // If a previous delivery already reached the external step, do not repeat
  // the full D1 deletion on every provider retry. Any earlier state replays S3
  // and S4 because each transaction is independently idempotent.
  if (String(saga.state) !== "external") {
    // S3 — SOCIAL_DB erasure transaction: every inventoried row class with a
    // player key (data-inventory.md; moderation reports deliberately retained
    // under their own access-controlled schedule — inventory row 21).
    await sagaState(env, playerId, "erasing");
    await env.SOCIAL_DB.batch([
      env.SOCIAL_DB.prepare("DELETE FROM friendships WHERE a = ?1 OR b = ?1").bind(playerId),
      env.SOCIAL_DB.prepare("DELETE FROM pair_state WHERE a = ?1 OR b = ?1").bind(playerId),
      // Both ownership directions: an invite this player CONSUMED still carries
      // their id in consumed_by, so erasing only inviter rows would retain the
      // deleted player's identifier on every invite they accepted (audit).
      env.SOCIAL_DB.prepare("DELETE FROM invites WHERE inviter = ?1 OR consumed_by = ?1").bind(playerId),
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
      // Moderation reports are RETAINED for abuse investigation (never deleted),
      // but the deleting player's identity as reporter is scrubbed to a tombstone
      // — retention WITH declared deidentification, so no live identifier of an
      // erased account survives in the reporter column (§6.4; audit).
      env.SOCIAL_DB.prepare("UPDATE moderation_reports SET reporter = 'erased' WHERE reporter = ?1").bind(playerId),
      env.SOCIAL_DB.prepare("DELETE FROM players WHERE player_id = ?1").bind(playerId),
    ]);

    // S4 — the player's projection shard.
    await env.PROJECTION_1.prepare("DELETE FROM day_state WHERE player_id = ?").bind(playerId).run();
  }

  // S5 — provider revocation (App Store requirement). Runs only when the SIWA
  // key secrets and a stored credential exist; the outcome is recorded either
  // way — "skipped" is a visible state, never a silent hole.
  await sagaState(env, playerId, "external");
  let revocation = "skipped-no-credential";
  const revocationBlob = blobBytes(saga.revocation);
  if (revocationBlob && env.APPLE_SIWA_KEY_P8 && env.APPLE_SIWA_KEY_ID) {
    try {
      revocation = (await revokeAppleToken(env, revocationBlob)) ? "revoked" : "failed";
    } catch { revocation = "failed"; }
    if (revocation === "failed") return false; // Queue/D1 recovery retries; attempts counted
  }

  // S6 — terminal: tombstone the journal, complete the marker.
  const t = Date.now();
  await env.ERASURE_DB.batch([
    env.ERASURE_DB.prepare(
      `UPDATE erasure_saga
       SET state = 'done', steps = ?2, updated_at = ?3, revocation = NULL
       WHERE player_id = ?1`)
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
    signal: AbortSignal.timeout(10_000),
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
