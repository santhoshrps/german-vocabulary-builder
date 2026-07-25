// Identity & session routes (batch W2): nonce, provider exchange, refresh
// rotation with grace, sign-out, session verification (IDENT-2/2b/2c).

import {
  SessionClaims, hashedSubject, mintJwt, randomToken, sha256Hex,
  verifyAppleIdentityToken, verifyJwt,
} from "./crypto";
import type { Env } from "./index";
import type { ErrorCode } from "./contract";
import { appleCodeExchange } from "./deletion";

export const ACTIVE_HMAC_VERSION = 1;
const JWT_TTL_SECONDS = 15 * 60;
const NONCE_TTL_MS = 5 * 60_000;
const REFRESH_INACTIVITY_MS = 180 * 86_400_000;
const ROTATION_GRACE_MS = 2 * 60_000;
const MAX_FAMILIES = 10;
// Pre-auth abuse control (NFR-4e: coarse network signal, bounded retention via
// the hour-window key; raw IPs never stored beyond it).
const AUTH_WINDOW_LIMIT = 30;

export interface SessionContext {
  playerId: string;
  family: string;
  nickname: string;
  boardRevision: number;
  sessionVersion: number;
}

export type AuthResult = { ok: true; ctx: SessionContext } | { ok: false; code: ErrorCode };

function now(): number { return Date.now(); }

/** Deterministic refresh successor: keyed by the server secret so it is
 *  unpredictable to a holder of the predecessor raw token, yet reproducible —
 *  a grace-window retry that presents the same predecessor recomputes the same
 *  successor and is never stranded (IDENT-2c). Only a hash of it is ever stored. */
async function successorToken(env: Env, family: string, baseHash: string): Promise<string> {
  return sha256Hex(`${env.SOCIAL_JWT_SECRET}|refresh-successor|${family}|${baseHash}`);
}

async function ipWindowExceeded(env: Env, request: Request): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const windowKey = `${new Date().toISOString().slice(0, 13)}`; // hour window
  const row = await env.SOCIAL_DB.prepare(
    `INSERT INTO quotas (player_id, kind, quota_day, count) VALUES (?1, 'auth', ?2, 1)
     ON CONFLICT (player_id, kind, quota_day) DO UPDATE SET count = count + 1
     RETURNING count`).bind(`ip:${await sha256Hex(ip)}`, windowKey).first();
  return Number(row?.count ?? 0) > AUTH_WINDOW_LIMIT;
}

// --- R3: nonce --------------------------------------------------------------

export async function handleNonce(request: Request, env: Env): Promise<{ code: ErrorCode; data?: unknown }> {
  if (await ipWindowExceeded(env, request)) return { code: "RATE_LIMITED" };
  const nonce = randomToken(24);
  await env.SOCIAL_DB.prepare("INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)")
    .bind(nonce, now() + NONCE_TTL_MS).run();
  return { code: "OK", data: { nonce, expiresInSeconds: NONCE_TTL_MS / 1000 } };
}

// --- R4: provider exchange ---------------------------------------------------

interface ExchangeBody { provider?: string; identityToken?: string; nonce?: string; authorizationCode?: string }

export async function handleExchange(request: Request, env: Env): Promise<{ code: ErrorCode; data?: unknown }> {
  if (await ipWindowExceeded(env, request)) return { code: "RATE_LIMITED" };
  let body: ExchangeBody;
  try { body = await request.json(); } catch { return { code: "SCHEMA_INVALID" }; }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some((k) => !["provider", "identityToken", "nonce", "authorizationCode"].includes(k))) {
    return { code: "SCHEMA_UNKNOWN_FIELD" };
  }
  if (!body.identityToken || !body.nonce) return { code: "SCHEMA_INVALID" };
  if (body.provider !== "apple") {
    // Google lands with the Android client; the row exists in the contract already.
    return body.provider === "google" ? { code: "NOT_IMPLEMENTED" } : { code: "SCHEMA_INVALID" };
  }

  // Single-use nonce: consume atomically FIRST — a replayed exchange dies here.
  const consumed = await env.SOCIAL_DB.prepare(
    "DELETE FROM nonces WHERE nonce = ?1 AND expires_at > ?2 RETURNING nonce")
    .bind(body.nonce, now()).first();
  if (!consumed) return { code: "AUTH_INVALID" };

  const identity = await verifyAppleIdentityToken(body.identityToken, env.APP_BUNDLE_ID);
  if (!identity || identity.nonce !== body.nonce) return { code: "AUTH_INVALID" };

  const hashed = await hashedSubject(env.IDENTITY_HMAC_KEY_V1, "apple", identity.subject);
  const credential = await env.SOCIAL_DB.prepare(
    "SELECT player_id FROM credentials WHERE provider = 'apple' AND key_version = ?1 AND hashed_subject = ?2")
    .bind(ACTIVE_HMAC_VERSION, hashed).first();
  const playerId = credential ? String(credential.player_id) : null;

  // Not joined yet: the client proceeds to R7 join with THIS exchange's session…
  // except there is no player row to bind a session to. The contract's answer:
  // exchange always returns a session; for an unjoined subject the session's sub
  // is a reserved pre-join principal derived from the credential hash, valid ONLY
  // for the join route, which creates the player and re-issues a full session.
  if (!playerId) {
    const family = crypto.randomUUID();
    const jwt = await mintJwt(env.SOCIAL_JWT_SECRET, prejoinClaims(env, hashed, family));
    return { code: "OK", data: { session: jwt, joined: false, expiresInSeconds: JWT_TTL_SECONDS } };
  }

  // Revocation credential (inventory row 2): exchanged + stored when the SIWA
  // key secrets exist; deletion's S5 needs it to sever the Apple-ID connection.
  if (typeof body.authorizationCode === "string" && body.authorizationCode.length <= 512) {
    const sealed = await appleCodeExchange(env, body.authorizationCode);
    if (sealed) {
      await env.SOCIAL_DB.prepare(
        "UPDATE credentials SET revocation = ?1 WHERE provider = 'apple' AND key_version = ?2 AND hashed_subject = ?3")
        .bind(sealed, ACTIVE_HMAC_VERSION, hashed).run();
    }
  }
  return { code: "OK", data: await issueSession(env, playerId) };
}

function prejoinClaims(env: Env, hashed: string, family: string): SessionClaims {
  const iat = Math.floor(now() / 1000);
  return {
    sub: `prejoin:apple:${ACTIVE_HMAC_VERSION}:${hashed}`,
    aud: "leaderboard", env: env.ENV_NAME, sv: 0, fam: family,
    iat, exp: iat + JWT_TTL_SECONDS, jti: crypto.randomUUID(),
  };
}

/** Mint JWT + rotating refresh credential. The ≤ 10 active-family cap is
 *  enforced by REFUSAL, never silent eviction (IDENT-2c; audit): an eleventh
 *  device is told it must retire one first (requiresDeviceManagement) and no
 *  existing family is touched — the user chooses which device to sign out. */
export async function issueSession(env: Env, playerId: string): Promise<unknown> {
  const player = await env.SOCIAL_DB.prepare(
    "SELECT session_version FROM players WHERE player_id = ?").bind(playerId).first();
  const sv = Number(player?.session_version ?? 1);

  // Count this player's live device families (a family row always has a family
  // PK; the explicit predicate keeps the scan family-scoped).
  const active = await env.SOCIAL_DB.prepare(
    "SELECT count(*) AS n FROM refresh_sessions WHERE family IS NOT NULL AND player_id = ?1 AND revoked = 0")
    .bind(playerId).first();
  if (Number(active?.n ?? 0) >= MAX_FAMILIES) {
    // At the device cap: refuse rather than evict. The client surfaces device
    // management; a family is revoked only by an explicit sign-out there.
    return { requiresDeviceManagement: true };
  }

  const family = crypto.randomUUID();
  const raw = randomToken(32);
  const t = now();
  await env.SOCIAL_DB.prepare(
    `INSERT INTO refresh_sessions (family, player_id, hashed_token, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(family, playerId, await sha256Hex(raw), t + REFRESH_INACTIVITY_MS, t).run();

  const iat = Math.floor(t / 1000);
  const jwt = await mintJwt(env.SOCIAL_JWT_SECRET, {
    sub: playerId, aud: "leaderboard", env: env.ENV_NAME, sv, fam: family,
    iat, exp: iat + JWT_TTL_SECONDS, jti: crypto.randomUUID(),
  });
  return {
    session: jwt, joined: true, expiresInSeconds: JWT_TTL_SECONDS,
    refreshCredential: `${family}.${raw}`,
  };
}

// --- R5: refresh (rotation + grace + reuse detection, IDENT-2c) -------------

export async function handleRefresh(request: Request, env: Env): Promise<{ code: ErrorCode; data?: unknown }> {
  if (await ipWindowExceeded(env, request)) return { code: "RATE_LIMITED" };
  let body: { refreshCredential?: string };
  try { body = await request.json(); } catch { return { code: "SCHEMA_INVALID" }; }
  const parts = (body.refreshCredential ?? "").split(".");
  if (parts.length !== 2) return { code: "SCHEMA_INVALID" };
  const [family, raw] = parts;
  const hashed = await sha256Hex(raw);
  const t = now();

  const row = await env.SOCIAL_DB.prepare(
    `SELECT player_id, hashed_token, prev_hashed_token, rotated_at, expires_at, revoked
     FROM refresh_sessions WHERE family = ?`).bind(family).first();
  if (!row || Number(row.revoked) === 1 || Number(row.expires_at) < t) {
    return { code: "AUTH_INVALID" };
  }

  const isCurrent = row.hashed_token === hashed;
  const isGracePrev = row.prev_hashed_token === hashed
    && row.rotated_at != null && t - Number(row.rotated_at) <= ROTATION_GRACE_MS;

  if (!isCurrent && !isGracePrev) {
    // Reuse inconsistent with grace/successor state — revoke the whole family
    // (the one signal that distinguishes theft from a lost response).
    await env.SOCIAL_DB.prepare("UPDATE refresh_sessions SET revoked = 1 WHERE family = ?")
      .bind(family).run();
    return { code: "AUTH_REFRESH_REUSED" };
  }

  // The successor is DERIVED from the predecessor's stored hash under the server
  // secret, so a lost-response retry inside grace recomputes the IDENTICAL
  // successor instead of rotating again and stranding the response the client
  // never saw (IDENT-2c). On the first presentation (isCurrent) we advance the
  // row; on a grace retry we recompute and return the same credential WITHOUT
  // rotating — the predecessor hash it derives from is unchanged either way.
  const baseHash = isCurrent ? String(row.hashed_token) : String(row.prev_hashed_token);
  const nextRaw = await successorToken(env, family, baseHash);
  if (isCurrent) {
    await env.SOCIAL_DB.prepare(
      `UPDATE refresh_sessions
       SET prev_hashed_token = hashed_token, hashed_token = ?1, rotated_at = ?2, expires_at = ?3
       WHERE family = ?4`)
      .bind(await sha256Hex(nextRaw), t, t + REFRESH_INACTIVITY_MS, family).run();
  }

  const playerId = String(row.player_id);
  const player = await env.SOCIAL_DB.prepare(
    "SELECT session_version FROM players WHERE player_id = ?").bind(playerId).first();
  if (!player) return { code: "PROFILE_GONE" };
  const iat = Math.floor(t / 1000);
  const jwt = await mintJwt(env.SOCIAL_JWT_SECRET, {
    sub: playerId, aud: "leaderboard", env: env.ENV_NAME,
    sv: Number(player.session_version), fam: family,
    iat, exp: iat + JWT_TTL_SECONDS, jti: crypto.randomUUID(),
  });
  return { code: "OK", data: { session: jwt, refreshCredential: `${family}.${nextRaw}`, expiresInSeconds: JWT_TTL_SECONDS } };
}

// --- R6: sign-out (online-only, revokes the session's family) ---------------

export async function handleSignout(env: Env, ctx: SessionContext): Promise<{ code: ErrorCode; data?: unknown }> {
  await env.SOCIAL_DB.prepare("UPDATE refresh_sessions SET revoked = 1 WHERE family = ? AND player_id = ?")
    .bind(ctx.family, ctx.playerId).run();
  return { code: "OK", data: { signedOut: true } };
}

// --- session verification (the router's guard) ------------------------------

export async function verifySession(request: Request, env: Env): Promise<AuthResult> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return { ok: false, code: "AUTH_INVALID" };
  const claims = await verifyJwt(env.SOCIAL_JWT_SECRET, header.slice(7));
  if (!claims) return { ok: false, code: "AUTH_INVALID" };
  if (claims.aud !== "leaderboard" || claims.env !== env.ENV_NAME) return { ok: false, code: "AUTH_INVALID" };
  if (claims.exp * 1000 < now()) return { ok: false, code: "AUTH_EXPIRED" };
  if (claims.sub.startsWith("prejoin:")) return { ok: false, code: "AUTH_INVALID" }; // join-only principal
  const player = await env.SOCIAL_DB.prepare(
    "SELECT nickname, board_revision, session_version FROM players WHERE player_id = ?")
    .bind(claims.sub).first();
  if (!player) return { ok: false, code: "PROFILE_GONE" };
  if (Number(player.session_version) !== claims.sv) return { ok: false, code: "AUTH_EXPIRED" };
  return {
    ok: true,
    ctx: {
      playerId: claims.sub, family: claims.fam,
      nickname: String(player.nickname),
      boardRevision: Number(player.board_revision),
      sessionVersion: Number(player.session_version),
    },
  };
}

/** The join route's special case: accepts the pre-join principal and returns its
 *  parts, or an already-joined player's context. */
export async function verifyJoinSession(request: Request, env: Env):
  Promise<{ prejoin?: { provider: string; keyVersion: number; hashed: string }; ctx?: SessionContext; code?: ErrorCode }> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return { code: "AUTH_INVALID" };
  const claims = await verifyJwt(env.SOCIAL_JWT_SECRET, header.slice(7));
  if (!claims || claims.aud !== "leaderboard" || claims.env !== env.ENV_NAME) return { code: "AUTH_INVALID" };
  if (claims.exp * 1000 < now()) return { code: "AUTH_EXPIRED" };
  if (claims.sub.startsWith("prejoin:")) {
    const [, provider, keyVersion, hashed] = claims.sub.split(":");
    return { prejoin: { provider, keyVersion: Number(keyVersion), hashed } };
  }
  const session = await verifySession(request, env);
  return session.ok ? { ctx: session.ctx } : { code: session.code };
}
