// W4 — invites, the accept transaction (T5), friends/blocks/mutes with RELY-9
// generations, cheers, reports, E18 receipts, and the idempotency layer for
// social mutations (publish is exempt by documented exception).

import { randomToken, sha256Hex } from "./crypto";
import { blobText } from "./blob";
import { quotaDay } from "./board";
import type { SessionContext } from "./auth";
import type { Env } from "./index";
import type { ErrorCode } from "./contract";

const INVITE_TTL_MS = 30 * 86_400_000;
const MAX_PENDING_INVITES = 20;
const INVITES_PER_DAY = 10;
const MAX_FRIENDS = 10;
const MAX_BLOCKS = 100;
const REPORTS_PER_DAY = 10;
const E18_LIFETIME_PAIRS = 100;
const E18_FULL_PAY_PER_DAY = 2;
const E18_LADDER = new Set([150, 250, 400, 600, 900, 1500]);
const E18_BASE = 150;
const REPORT_REASONS = new Set(["offensive_name", "impersonation", "spam", "other"]);
const IDEMPOTENCY_TTL_MS = 48 * 3_600_000;

type Result = { code: ErrorCode; data?: unknown };

function pair(x: string, y: string): [string, string] { return x < y ? [x, y] : [y, x]; }

// --- idempotency (contract §2: key scoped to player + route) -----------------

export async function withIdempotency(
  request: Request, env: Env, ctx: SessionContext, route: string, bodyText: string,
  run: () => Promise<Result>,
): Promise<Result> {
  const key = request.headers.get("idempotency-key");
  if (!key || key.length > 64) return { code: "SCHEMA_INVALID" };
  const requestHash = await sha256Hex(`${route}|${bodyText}`);
  const existing = await env.SOCIAL_DB.prepare(
    "SELECT request_hash, result FROM idempotency WHERE player_id = ?1 AND route = ?2 AND idem_key = ?3")
    .bind(ctx.playerId, route, key).first();
  if (existing) {
    if (existing.request_hash !== requestHash) return { code: "IDEMPOTENCY_MISMATCH" };
    return JSON.parse(blobText(existing.result) ?? "{}") as Result;
  }
  const result = await run();
  // Semantic outcomes (OK and typed refusals) are recorded; INTERNAL is not —
  // a transport-shaped failure must stay retryable (RELY-3).
  if (result.code !== "INTERNAL") {
    await env.SOCIAL_DB.prepare(
      `INSERT OR IGNORE INTO idempotency (player_id, route, idem_key, request_hash, result, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(ctx.playerId, route, key, requestHash,
        new TextEncoder().encode(JSON.stringify(result)), Date.now() + IDEMPOTENCY_TTL_MS).run();
  }
  return result;
}

// --- quota helper: conditional count, never burns a slot on refusal ----------

async function takeQuota(env: Env, playerId: string, kind: string, day: string, limit: number): Promise<boolean> {
  await env.SOCIAL_DB.prepare(
    "INSERT OR IGNORE INTO quotas (player_id, kind, quota_day, count) VALUES (?1, ?2, ?3, 0)")
    .bind(playerId, kind, day).run();
  const took = await env.SOCIAL_DB.prepare(
    "UPDATE quotas SET count = count + 1 WHERE player_id = ?1 AND kind = ?2 AND quota_day = ?3 AND count < ?4")
    .bind(playerId, kind, day, limit).run();
  return (took.meta?.changes ?? 0) > 0;
}

async function playerZone(env: Env, playerId: string): Promise<string> {
  const row = await env.SOCIAL_DB.prepare("SELECT tz_zone FROM players WHERE player_id = ?").bind(playerId).first();
  return String(row?.tz_zone ?? "UTC");
}

// --- R14 invites list --------------------------------------------------------

export async function handleInvitesList(env: Env, ctx: SessionContext): Promise<Result> {
  const rows = await env.SOCIAL_DB.prepare(
    `SELECT token_hash, state, created_at, expires_at FROM invites
     WHERE inviter = ?1 AND state = 'pending' AND expires_at > ?2 ORDER BY created_at DESC`)
    .bind(ctx.playerId, Date.now()).all();
  return {
    code: "OK",
    data: {
      invites: (rows.results ?? []).map((r) => ({
        id: String(r.token_hash).slice(0, 16), createdAt: r.created_at, expiresAt: r.expires_at,
      })),
    },
  };
}

// --- R15 invite create -------------------------------------------------------

export async function handleInviteCreate(request: Request, env: Env, ctx: SessionContext): Promise<Result> {
  const day = quotaDay(await playerZone(env, ctx.playerId));
  const pending = await env.SOCIAL_DB.prepare(
    "SELECT count(*) AS n FROM invites WHERE inviter = ?1 AND state = 'pending' AND expires_at > ?2")
    .bind(ctx.playerId, Date.now()).first();
  if (Number(pending?.n ?? 0) >= MAX_PENDING_INVITES) return { code: "LIMIT_INVITES_DAY" };
  if (!(await takeQuota(env, ctx.playerId, "invite", day, INVITES_PER_DAY))) {
    return { code: "LIMIT_INVITES_DAY" };
  }
  const token = randomToken(32); // ≥ 128-bit entropy (FRIEND-1b); only its hash is stored
  const hash = await sha256Hex(token);
  const t = Date.now();
  await env.SOCIAL_DB.prepare(
    "INSERT INTO invites (token_hash, inviter, state, created_at, expires_at) VALUES (?1, ?2, 'pending', ?3, ?4)")
    .bind(hash, ctx.playerId, t, t + INVITE_TTL_MS).run();
  // Prod: learn-languages.app/german/join (owner decision 2026-07-25); dev rides
  // the worker's own origin. Fragment-carried, never logged (FRIEND-1b).
  const base = env.INVITE_LINK_BASE || `${new URL(request.url).origin}/german/join`;
  return {
    code: "OK",
    data: { inviteId: hash.slice(0, 16), link: `${base}#${token}`, expiresAt: t + INVITE_TTL_MS },
  };
}

// --- R16 withdraw ------------------------------------------------------------

export async function handleInviteWithdraw(body: { inviteId?: string }, env: Env, ctx: SessionContext): Promise<Result> {
  if (typeof body.inviteId !== "string" || body.inviteId.length !== 16) return { code: "SCHEMA_INVALID" };
  await env.SOCIAL_DB.prepare(
    `UPDATE invites SET state = 'withdrawn' WHERE inviter = ?1 AND state = 'pending'
     AND substr(token_hash, 1, 16) = ?2`)
    .bind(ctx.playerId, body.inviteId).run();
  return { code: "OK", data: { withdrawn: true } }; // idempotent — absent/consumed converge
}

// --- R17 preview (invite-token possession; NEVER consumes — FRIEND-1b) -------

export async function handleInvitePreview(request: Request, env: Env): Promise<Result> {
  let body: { token?: string };
  try { body = await request.json(); } catch { return { code: "SCHEMA_INVALID" }; }
  if (typeof body.token !== "string" || body.token.length > 64) return { code: "SCHEMA_INVALID" };
  const hash = await sha256Hex(body.token);
  const invite = await env.SOCIAL_DB.prepare(
    `SELECT i.state, i.expires_at, p.nickname FROM invites i JOIN players p ON p.player_id = i.inviter
     WHERE i.token_hash = ?`).bind(hash).first();
  if (!invite) return { code: "INVITE_EXPIRED" };
  if (invite.state === "withdrawn") return { code: "INVITE_WITHDRAWN" };
  if (invite.state === "consumed") return { code: "INVITE_CONSUMED" };
  if (Number(invite.expires_at) < Date.now()) return { code: "INVITE_EXPIRED" };
  return { code: "OK", data: { inviterNickname: String(invite.nickname) } };
}

// --- R18 accept — THE transaction (T5) ---------------------------------------

export async function handleInviteAccept(body: { token?: string }, env: Env, ctx: SessionContext): Promise<Result> {
  if (typeof body.token !== "string" || body.token.length > 64) return { code: "SCHEMA_INVALID" };
  const hash = await sha256Hex(body.token);
  const t = Date.now();
  const invite = await env.SOCIAL_DB.prepare(
    "SELECT inviter, state, expires_at FROM invites WHERE token_hash = ?").bind(hash).first();
  if (!invite) return { code: "INVITE_EXPIRED" };
  if (invite.state === "withdrawn") return { code: "INVITE_WITHDRAWN" };
  if (invite.state === "consumed") return { code: "INVITE_CONSUMED" };
  if (Number(invite.expires_at) < t) return { code: "INVITE_EXPIRED" };
  const inviter = String(invite.inviter);
  if (inviter === ctx.playerId) return { code: "INVITE_OWN" }; // graceful, NOT consumed (ROBUST-6)

  const [a, b] = pair(ctx.playerId, inviter);
  const day = quotaDay(await playerZone(env, ctx.playerId));

  // One atomic batch: conditional consume · block guard · both caps · edge ·
  // generation · E18 pair guard + receipts (quota-day tier ordinal) · revisions.
  // Every condition re-checks INSIDE the transaction; a failed condition simply
  // writes nothing for its statement, classified below.
  const receiptAccepter = crypto.randomUUID();
  const receiptInviter = crypto.randomUUID();
  const results = await env.SOCIAL_DB.batch([
    /* 0 */ env.SOCIAL_DB.prepare(
      `UPDATE invites SET state = 'consumed', consumed_by = ?2 WHERE token_hash = ?1 AND state = 'pending' AND expires_at > ?3`)
      .bind(hash, ctx.playerId, t),
    /* 1 */ env.SOCIAL_DB.prepare(
      `INSERT INTO friendships (a, b, generation, created_at)
       SELECT ?1, ?2, COALESCE((SELECT generation FROM pair_state WHERE a = ?1 AND b = ?2), 0) + 1, ?3
       WHERE NOT EXISTS (SELECT 1 FROM friendships WHERE a = ?1 AND b = ?2)
         AND NOT EXISTS (SELECT 1 FROM blocks WHERE (owner = ?1 AND target = ?2) OR (owner = ?2 AND target = ?1))
         AND (SELECT count(*) FROM friendships WHERE a = ?4 OR b = ?4) < ${MAX_FRIENDS}
         AND (SELECT count(*) FROM friendships WHERE a = ?5 OR b = ?5) < ${MAX_FRIENDS}`)
      .bind(a, b, t, ctx.playerId, inviter),
    /* 2 */ env.SOCIAL_DB.prepare(
      `INSERT INTO pair_state (a, b, generation, updated_at) VALUES (?1, ?2, 1, ?3)
       ON CONFLICT (a, b) DO UPDATE SET generation = generation + 1, tombstoned_at = NULL, updated_at = ?3
       WHERE EXISTS (SELECT 1 FROM friendships WHERE a = ?1 AND b = ?2)`)
      .bind(a, b, t),
    /* 3 */ env.SOCIAL_DB.prepare(
      `INSERT INTO e18_pairs (a, b, created_at)
       SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM friendships WHERE a = ?1 AND b = ?2)
         AND NOT EXISTS (SELECT 1 FROM e18_pairs WHERE a = ?1 AND b = ?2)
         AND (SELECT count(*) FROM e18_pairs WHERE a IN (?4, ?5) OR b IN (?4, ?5)) < ${E18_LIFETIME_PAIRS}`)
      .bind(a, b, t, ctx.playerId, inviter),
    /* 4 */ env.SOCIAL_DB.prepare(
      "INSERT OR IGNORE INTO quotas (player_id, kind, quota_day, count) VALUES (?1, 'e18full', ?2, 0)")
      .bind(ctx.playerId, day),
    /* 5 */ env.SOCIAL_DB.prepare(
      `UPDATE quotas SET count = count + 1 WHERE player_id = ?1 AND kind = 'e18full' AND quota_day = ?2
       AND EXISTS (SELECT 1 FROM e18_pairs WHERE a = ?3 AND b = ?4 AND created_at = ?5)`)
      .bind(ctx.playerId, day, a, b, t),
    /* 6 */ env.SOCIAL_DB.prepare(
      `INSERT INTO e18_receipts (receipt_id, player_id, pair_a, pair_b, rule_version, tier_ordinal, created_at)
       SELECT ?1, ?2, ?3, ?4, 1,
              (SELECT count FROM quotas WHERE player_id = ?2 AND kind = 'e18full' AND quota_day = ?5),
              ?6
       WHERE EXISTS (SELECT 1 FROM e18_pairs WHERE a = ?3 AND b = ?4 AND created_at = ?6)`)
      .bind(receiptAccepter, ctx.playerId, a, b, day, t),
    /* 7 */ env.SOCIAL_DB.prepare(
      `INSERT INTO e18_receipts (receipt_id, player_id, pair_a, pair_b, rule_version, tier_ordinal, created_at)
       SELECT ?1, ?2, ?3, ?4, 1, 1, ?5
       WHERE EXISTS (SELECT 1 FROM e18_pairs WHERE a = ?3 AND b = ?4 AND created_at = ?5)`)
      .bind(receiptInviter, inviter, a, b, t),
    /* 8 */ env.SOCIAL_DB.prepare(
      `UPDATE players SET board_revision = board_revision + 1, updated_at = ?2 WHERE player_id IN (?1, ?3)`)
      .bind(ctx.playerId, t, inviter),
  ]);

  const consumed = (results[0].meta?.changes ?? 0) > 0;
  const linked = (results[1].meta?.changes ?? 0) > 0;
  if (!consumed) {
    // Raced another accept between read and batch — re-classify honestly.
    const now = await env.SOCIAL_DB.prepare(
      "SELECT state FROM invites WHERE token_hash = ?").bind(hash).first();
    return { code: now?.state === "withdrawn" ? "INVITE_WITHDRAWN" : "INVITE_CONSUMED" };
  }
  if (!linked) {
    const existing = await env.SOCIAL_DB.prepare(
      "SELECT 1 FROM friendships WHERE a = ?1 AND b = ?2").bind(a, b).first();
    if (existing) return { code: "ALREADY_FRIENDS" }; // token consumed — FRIEND-1c
    const blocked = await env.SOCIAL_DB.prepare(
      "SELECT 1 FROM blocks WHERE (owner = ?1 AND target = ?2) OR (owner = ?2 AND target = ?1)")
      .bind(ctx.playerId, inviter).first();
    // Blocked reads as an expired link — a block must never be inferable (FRIEND-13).
    return { code: blocked ? "INVITE_EXPIRED" : "LIMIT_FRIENDS" };
  }
  const inviterRow = await env.SOCIAL_DB.prepare(
    "SELECT nickname FROM players WHERE player_id = ?").bind(inviter).first();
  const generation = await env.SOCIAL_DB.prepare(
    "SELECT generation FROM pair_state WHERE a = ?1 AND b = ?2").bind(a, b).first();
  const paidPair = (results[3].meta?.changes ?? 0) > 0;
  return {
    code: "OK",
    data: {
      friend: { playerId: inviter, nickname: String(inviterRow?.nickname ?? "") },
      generation: Number(generation?.generation ?? 1),
      e18: paidPair ? { receiptId: receiptAccepter, ruleVersion: 1 } : null,
    },
  };
}

// --- R19/R20/R21: safety actions (queued class — ALWAYS apply; RELY-9) -------

export async function handleRemove(body: { playerId?: string }, env: Env, ctx: SessionContext): Promise<Result> {
  if (typeof body.playerId !== "string") return { code: "SCHEMA_INVALID" };
  const [a, b] = pair(ctx.playerId, body.playerId);
  const t = Date.now();
  await env.SOCIAL_DB.batch([
    env.SOCIAL_DB.prepare("DELETE FROM friendships WHERE a = ?1 AND b = ?2").bind(a, b),
    env.SOCIAL_DB.prepare(
      `INSERT INTO pair_state (a, b, generation, tombstoned_at, updated_at) VALUES (?1, ?2, 1, ?3, ?3)
       ON CONFLICT (a, b) DO UPDATE SET generation = generation + 1, tombstoned_at = ?3, updated_at = ?3`)
      .bind(a, b, t),
    env.SOCIAL_DB.prepare(
      "UPDATE players SET board_revision = board_revision + 1, updated_at = ?2 WHERE player_id IN (?1, ?3)")
      .bind(ctx.playerId, t, body.playerId),
  ]);
  return { code: "OK", data: { removed: true, generation: await currentGeneration(env, a, b) } };
}

export async function handleBlock(body: { playerId?: string }, env: Env, ctx: SessionContext): Promise<Result> {
  if (typeof body.playerId !== "string" || body.playerId === ctx.playerId) return { code: "SCHEMA_INVALID" };
  const blocks = await env.SOCIAL_DB.prepare(
    "SELECT count(*) AS n FROM blocks WHERE owner = ?").bind(ctx.playerId).first();
  if (Number(blocks?.n ?? 0) >= MAX_BLOCKS) return { code: "LIMIT_BLOCKS" };
  const [a, b] = pair(ctx.playerId, body.playerId);
  const t = Date.now();
  await env.SOCIAL_DB.batch([
    env.SOCIAL_DB.prepare("DELETE FROM friendships WHERE a = ?1 AND b = ?2").bind(a, b),
    env.SOCIAL_DB.prepare(
      `UPDATE invites SET state = 'withdrawn' WHERE state = 'pending'
       AND ((inviter = ?1 AND consumed_by IS NULL) OR inviter = ?2) AND inviter IN (?1, ?2)`)
      .bind(ctx.playerId, body.playerId),
    env.SOCIAL_DB.prepare(
      "INSERT OR IGNORE INTO blocks (owner, target, created_at) VALUES (?1, ?2, ?3)")
      .bind(ctx.playerId, body.playerId, t),
    env.SOCIAL_DB.prepare(
      `INSERT INTO pair_state (a, b, generation, tombstoned_at, updated_at) VALUES (?1, ?2, 1, ?3, ?3)
       ON CONFLICT (a, b) DO UPDATE SET generation = generation + 1, tombstoned_at = ?3, updated_at = ?3`)
      .bind(a, b, t),
    env.SOCIAL_DB.prepare(
      "UPDATE players SET board_revision = board_revision + 1, updated_at = ?2 WHERE player_id IN (?1, ?3)")
      .bind(ctx.playerId, t, body.playerId),
  ]);
  return { code: "OK", data: { blocked: true, generation: await currentGeneration(env, a, b) } };
}

export async function handleMute(body: { playerId?: string }, env: Env, ctx: SessionContext, mute: boolean): Promise<Result> {
  if (typeof body.playerId !== "string") return { code: "SCHEMA_INVALID" };
  if (mute) {
    await env.SOCIAL_DB.prepare(
      "INSERT OR IGNORE INTO mutes (owner, target, created_at) VALUES (?1, ?2, ?3)")
      .bind(ctx.playerId, body.playerId, Date.now()).run();
    return { code: "OK", data: { muted: true } };
  }
  // Unmute is constructive — generation-gated (RELY-9).
  return constructiveReversal(body as { playerId: string; observedGeneration?: number }, env, ctx,
    env.SOCIAL_DB.prepare("DELETE FROM mutes WHERE owner = ?1 AND target = ?2").bind(ctx.playerId, body.playerId));
}

export async function handleUnblock(body: { playerId?: string; observedGeneration?: number }, env: Env, ctx: SessionContext): Promise<Result> {
  if (typeof body.playerId !== "string") return { code: "SCHEMA_INVALID" };
  return constructiveReversal(body as { playerId: string; observedGeneration?: number }, env, ctx,
    env.SOCIAL_DB.prepare("DELETE FROM blocks WHERE owner = ?1 AND target = ?2").bind(ctx.playerId, body.playerId));
}

async function constructiveReversal(
  body: { playerId: string; observedGeneration?: number }, env: Env, ctx: SessionContext,
  action: D1PreparedStatement,
): Promise<Result> {
  const [a, b] = pair(ctx.playerId, body.playerId);
  const current = await currentGeneration(env, a, b);
  if (!Number.isInteger(body.observedGeneration) || body.observedGeneration !== current) {
    return { code: "GENERATION_STALE", data: { currentGeneration: current } };
  }
  const t = Date.now();
  await env.SOCIAL_DB.batch([
    action,
    env.SOCIAL_DB.prepare(
      `INSERT INTO pair_state (a, b, generation, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (a, b) DO UPDATE SET generation = generation + 1, updated_at = ?4`)
      .bind(a, b, current + 1, t),
    env.SOCIAL_DB.prepare(
      "UPDATE players SET board_revision = board_revision + 1, updated_at = ?2 WHERE player_id = ?1")
      .bind(ctx.playerId, t),
  ]);
  return { code: "OK", data: { generation: current + 1 } };
}

async function currentGeneration(env: Env, a: string, b: string): Promise<number> {
  const row = await env.SOCIAL_DB.prepare(
    "SELECT generation FROM pair_state WHERE a = ?1 AND b = ?2").bind(a, b).first();
  return Number(row?.generation ?? 0);
}

// --- R22 cheer ---------------------------------------------------------------

export async function handleCheer(body: { playerId?: string }, env: Env, ctx: SessionContext): Promise<Result> {
  if (typeof body.playerId !== "string") return { code: "SCHEMA_INVALID" };
  const [a, b] = pair(ctx.playerId, body.playerId);
  const edge = await env.SOCIAL_DB.prepare(
    "SELECT 1 FROM friendships WHERE a = ?1 AND b = ?2").bind(a, b).first();
  if (!edge) return { code: "PROFILE_GONE" };
  const day = quotaDay(await playerZone(env, ctx.playerId));
  const existing = await env.SOCIAL_DB.prepare(
    "SELECT quota_day FROM cheers WHERE from_player = ?1 AND to_player = ?2")
    .bind(ctx.playerId, body.playerId).first();
  if (existing?.quota_day === day) return { code: "OK", data: { sent: true, already: true } }; // converge (CHEER-3)
  const t = Date.now();
  await env.SOCIAL_DB.batch([
    env.SOCIAL_DB.prepare(
      `INSERT INTO cheers (from_player, to_player, quota_day, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (from_player, to_player) DO UPDATE SET quota_day = ?3, created_at = ?4
       WHERE cheers.quota_day <> ?3`)
      .bind(ctx.playerId, body.playerId, day, t),
    env.SOCIAL_DB.prepare(
      "UPDATE players SET board_revision = board_revision + 1, updated_at = ?2 WHERE player_id = ?1")
      .bind(body.playerId, t),
  ]);
  return { code: "OK", data: { sent: true, already: false } };
}

// --- R23 report --------------------------------------------------------------

export async function handleReport(body: { playerId?: string; reason?: string; note?: string }, env: Env, ctx: SessionContext): Promise<Result> {
  if (typeof body.playerId !== "string" || !REPORT_REASONS.has(body.reason ?? "")) return { code: "SCHEMA_INVALID" };
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 500)) return { code: "SCHEMA_INVALID" };
  const day = quotaDay(await playerZone(env, ctx.playerId));
  if (!(await takeQuota(env, ctx.playerId, "report", day, REPORTS_PER_DAY))) return { code: "LIMIT_REPORTS_DAY" };
  // Coalesce repeats against the same unchanged profile: deterministic report id.
  const reportId = await sha256Hex(`report|${ctx.playerId}|${body.playerId}`);
  await env.SOCIAL_DB.prepare(
    `INSERT OR IGNORE INTO moderation_reports (report_id, reporter, subject, reason, note, state, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6)`)
    .bind(reportId, ctx.playerId, body.playerId, body.reason, body.note ?? null, Date.now()).run();
  return { code: "OK", data: { reported: true } };
}

// --- R24/R25: E18 receipts ---------------------------------------------------

export async function handleReceiptsList(env: Env, ctx: SessionContext): Promise<Result> {
  const rows = await env.SOCIAL_DB.prepare(
    `SELECT receipt_id, rule_version, tier_ordinal, finalized_amount, created_at
     FROM e18_receipts WHERE player_id = ?1 AND acked = 0`).bind(ctx.playerId).all();
  return {
    code: "OK",
    data: {
      receipts: (rows.results ?? []).map((r) => ({
        receiptId: r.receipt_id, ruleVersion: r.rule_version, tierOrdinal: r.tier_ordinal,
        finalizedAmount: r.finalized_amount, createdAt: r.created_at,
      })),
    },
  };
}

export async function handleReceiptAck(body: { receiptId?: string; offeredAmount?: number }, env: Env, ctx: SessionContext): Promise<Result> {
  if (typeof body.receiptId !== "string" || !Number.isInteger(body.offeredAmount)) return { code: "SCHEMA_INVALID" };
  const receipt = await env.SOCIAL_DB.prepare(
    "SELECT tier_ordinal, finalized_amount FROM e18_receipts WHERE receipt_id = ?1 AND player_id = ?2")
    .bind(body.receiptId, ctx.playerId).first();
  if (!receipt) return { code: "NOT_FOUND" };
  const offered = Number(body.offeredAmount);
  // Ladder + tier validation (FRIEND-11): first two links per quota day pay the
  // full chased-band amount; later links pay base.
  const valid = Number(receipt.tier_ordinal) <= E18_FULL_PAY_PER_DAY ? E18_LADDER.has(offered) : offered === E18_BASE;
  if (!valid) return { code: "SCHEMA_INVALID" };
  const finalize = await env.SOCIAL_DB.prepare(
    `UPDATE e18_receipts SET finalized_amount = ?1, acked = 1
     WHERE receipt_id = ?2 AND player_id = ?3 AND finalized_amount IS NULL`)
    .bind(offered, body.receiptId, ctx.playerId).run();
  if ((finalize.meta?.changes ?? 0) === 0) {
    // Lost the race — converge on the finalized amount (first valid ack won).
    const now = await env.SOCIAL_DB.prepare(
      "SELECT finalized_amount FROM e18_receipts WHERE receipt_id = ?").bind(body.receiptId).first();
    return { code: "OK", data: { finalizedAmount: Number(now?.finalized_amount), won: false } };
  }
  return { code: "OK", data: { finalizedAmount: offered, won: true } };
}
