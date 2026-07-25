// R13 board read (batch W3b) — one bounded authorized snapshot (BOARD-11):
// self + ≤ 10 friends, viewer-zone period figures computed per algebra §3.8,
// composite ETag over everything that can change the snapshot (audit LB3D-004),
// conditional 304, no N+1 (IN-list fetches only).

import {
  DayComponent, EMPTY_REGISTERS, QH_MS, Registers, bitsOf, componentPointsIn,
  decodeDayComponent, viewerRanges,
} from "./algebra";
import { sha256Hex } from "./crypto";
import { blobBytes, blobText } from "./blob";
import { ENVELOPE_V1 } from "./algebra";
import { dayU16Today, labelOf, windowStartU16 } from "./publish";
import type { SessionContext } from "./auth";
import type { Env } from "./index";
import type { ErrorCode } from "./contract";

const TIME_DAILY_CAP = 12; // E7 read clamp (points.md), applied per earner-day

interface PlayerFigures {
  playerId: string; nickname: string;
  weekPts: number; monthPts: number; allTime: number;
  streak: number; mastered: number;
  lastActiveDaysAgo: number | null;
  duoDays: string[];
}

export async function handleBoard(
  request: Request, env: Env, ctx: SessionContext,
): Promise<{ code: ErrorCode; data?: unknown; headers?: Record<string, string>; notModified?: boolean }> {
  const me = ctx.playerId;
  const player = await env.SOCIAL_DB.prepare(
    "SELECT tz_zone, board_revision FROM players WHERE player_id = ?").bind(me).first();
  if (!player) return { code: "PROFILE_GONE" };
  const viewerZone = String(player.tz_zone);

  const edges = await env.SOCIAL_DB.prepare(
    "SELECT a, b, generation FROM friendships WHERE a = ?1 OR b = ?1 LIMIT 10").bind(me).all();
  const friendIds = (edges.results ?? []).map((e) => (e.a === me ? e.b : e.a) as string);
  const ids = [me, ...friendIds];
  const marks = ids.map(() => "?").join(",");

  // Per-pair relationship generation for each friend (RELY-9; audit LB3A-005):
  // the client records it on any queued safety action so a stale offline mutation
  // can never target a newer relationship. The friendship row's generation is the
  // authoritative current value.
  const generationByFriend = new Map<string, number>();
  for (const e of edges.results ?? []) {
    const friend = (e.a === me ? e.b : e.a) as string;
    generationByFriend.set(friend, Number(e.generation ?? 1));
  }

  const playerRows = await env.SOCIAL_DB.prepare(
    `SELECT player_id, nickname, board_revision FROM players WHERE player_id IN (${marks})`)
    .bind(...ids).all();
  const revisions = new Map((playerRows.results ?? []).map((r) => [String(r.player_id), Number(r.board_revision)]));

  // Composite ETag (LB3D-004): relationship set + generations + every visible
  // row's projection revision + viewer zone. Any visible publish, edge change,
  // action-state change (cheer bumps recipient revision) or zone change moves it.
  const cheered = await env.SOCIAL_DB.prepare(
    `SELECT to_player, quota_day FROM cheers WHERE from_player = ?`).bind(me).all();
  const etagBasis = JSON.stringify([
    viewerZone,
    (edges.results ?? []).map((e) => [e.a, e.b, e.generation]),
    [...revisions.entries()].sort(),
    (cheered.results ?? []).map((c) => [c.to_player, c.quota_day]).sort(),
  ]);
  const etag = `"${(await sha256Hex(etagBasis)).slice(0, 24)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return { code: "OK", notModified: true, headers: { etag } };
  }

  const windowStart = windowStartU16();
  const [dayRows, regRows, checkRows, awardRows, spendRows, duoRows] = await Promise.all([
    env.PROJECTION_1.prepare(
      `SELECT player_id, day_u16, blob FROM day_state
       WHERE player_id IN (${marks}) AND day_u16 >= ?`).bind(...ids, windowStart).all(),
    env.SOCIAL_DB.prepare(
      `SELECT player_id, data FROM registers WHERE player_id IN (${marks})`).bind(...ids).all(),
    env.SOCIAL_DB.prepare(
      `SELECT player_id, sum(earned_folded) AS earned FROM checkpoints
       WHERE player_id IN (${marks}) GROUP BY player_id`).bind(...ids).all(),
    env.SOCIAL_DB.prepare(
      `SELECT player_id, points, bucket, everlasting FROM awards_window WHERE player_id IN (${marks})`)
      .bind(...ids).all(),
    env.SOCIAL_DB.prepare(
      `SELECT player_id, amount, refunded FROM spends WHERE player_id IN (${marks})`).bind(...ids).all(),
    env.SOCIAL_DB.prepare(
      `SELECT player_id, day_label FROM duo_receipts WHERE player_id IN (${marks})`).bind(...ids).all(),
  ]);

  const regsOf = new Map<string, Registers>();
  for (const r of regRows.results ?? []) {
    const text = blobText(r.data);
    regsOf.set(String(r.player_id), text ? JSON.parse(text) : EMPTY_REGISTERS);
  }
  const checkpointEarned = new Map((checkRows.results ?? []).map((r) => [String(r.player_id), Number(r.earned ?? 0)]));
  const duoDaysOf = new Map<string, Set<number>>();
  for (const r of duoRows.results ?? []) {
    const set = duoDaysOf.get(String(r.player_id)) ?? new Set<number>();
    set.add(Math.floor(Date.parse(`${r.day_label}T00:00:00Z`) / 86_400_000));
    duoDaysOf.set(String(r.player_id), set);
  }

  const ranges = viewerRanges(viewerZone, new Date());
  const today = dayU16Today();
  const figures = new Map<string, PlayerFigures>();
  for (const id of ids) {
    const regs = regsOf.get(id) ?? EMPTY_REGISTERS;
    const active = bitsOf(regs);
    const lastActive = active.size ? Math.max(...active) : null;
    figures.set(id, {
      playerId: id, nickname: "",
      weekPts: 0, monthPts: 0,
      allTime: Math.max(0, regs.seed.earned + (checkpointEarned.get(id) ?? 0) - (regs.seed.spent - regs.seed.refunded)),
      streak: regs.streak.v, mastered: regs.mastered.v,
      lastActiveDaysAgo: lastActive === null ? null : Math.max(0, today - lastActive),
      duoDays: [...(duoDaysOf.get(id) ?? [])].map(labelOf),
    });
  }
  for (const r of playerRows.results ?? []) {
    const f = figures.get(String(r.player_id));
    if (f) f.nickname = String(r.nickname);
  }

  // Live-window day figures: per (player, day) — clamp time across components,
  // double session class on duo days, add to week/month/allTime.
  const byPlayerDay = new Map<string, DayComponent[]>();
  for (const row of dayRows.results ?? []) {
    try {
      const key = `${row.player_id}|${row.day_u16}`;
      const list = byPlayerDay.get(key) ?? [];
      const bytes = blobBytes(row.blob);
      if (!bytes) continue;
      list.push(decodeDayComponent(bytes));
      byPlayerDay.set(key, list);
    } catch { /* poison row: skip, never wedge (ROBUST-8) */ }
  }
  for (const [key, components] of byPlayerDay) {
    const [id, dayText] = key.split("|");
    const day = Number(dayText);
    const f = figures.get(id);
    if (!f) continue;
    const duo = duoDaysOf.get(id)?.has(day) ? 2 : 1;
    for (const range of [null, ranges.week, ranges.month] as const) {
      let s = 0, w = 0, t = 0;
      for (const c of components) {
        const p = range
          ? componentPointsIn(c, day, range)
          : { sessionPts: c.counters.sessionPts, wordPts: c.counters.wordPts, timePts: c.counters.timePts };
        s += p.sessionPts; w += p.wordPts; t += p.timePts;
      }
      const total = s * duo + w + Math.min(TIME_DAILY_CAP, t);
      if (range === null) f.allTime += total;
      else if (range === ranges.week) f.weekPts += total;
      else f.monthPts += total;
    }
  }
  for (const r of awardRows.results ?? []) {
    const f = figures.get(String(r.player_id));
    if (!f) continue;
    const at = Number(r.bucket) * QH_MS;
    const points = Number(r.points);
    if (!Number(r.everlasting)) f.allTime += points; // everlasting pts already in seed/checkpoint
    if (at >= ranges.week.startMs && at < ranges.week.endMs) f.weekPts += points;
    if (at >= ranges.month.startMs && at < ranges.month.endMs) f.monthPts += points;
  }
  for (const r of spendRows.results ?? []) {
    const f = figures.get(String(r.player_id));
    if (f && !Number(r.refunded)) f.allTime = Math.max(0, f.allTime - Number(r.amount));
  }
  // Defense in depth (ROBUST-2/3): clamp visible figures to the envelope-derived sane range.
  for (const f of figures.values()) {
    f.weekPts = Math.min(f.weekPts, ENVELOPE_V1.dailyCeiling * 7);
    f.monthPts = Math.min(f.monthPts, ENVELOPE_V1.dailyCeiling * 31);
  }

  const cheeredToday = new Set((cheered.results ?? [])
    .filter((c) => String(c.quota_day) === quotaDay(viewerZone))
    .map((c) => String(c.to_player)));

  const self = figures.get(me)!;
  return {
    code: "OK",
    headers: { etag },
    data: {
      serverTimeMs: Date.now(),
      viewerZone,
      self,
      friends: friendIds.map((id) => ({
        ...figures.get(id)!,
        duoDays: undefined, // duo detail is self-only; friends expose figures only
        cheeredToday: cheeredToday.has(id),
        generation: generationByFriend.get(id) ?? 1,   // RELY-9 (audit LB3A-005)
      })),
    },
  };
}

export function quotaDay(zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}
