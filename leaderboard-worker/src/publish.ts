// R12 publish (batch W3b) — the two-commit merge of algebra v1.1 §5.
// Commit A: guarded per-component day-row joins on the player's projection shard.
// Commit B: SOCIAL_DB register/award/spend joins, activity bitmap, duo-receipt
// minting, revision bump iff changed. Idempotent by construction — a replay
// returns CURRENT state with changed=false (ROBUST-6b documented exception).

import {
  Bucket, DayComponent, EMPTY_REGISTERS, MAX_BUCKETS, Registers, bitsOf,
  bucketsConsistent, decodeDayComponent, encodeDayComponent, envelopeViolation,
  joinBitmaps, joinRegisters, measureOf, setBit,
} from "./algebra";
import { sha256Hex } from "./crypto";
import type { SessionContext } from "./auth";
import type { Env } from "./index";
import type { ErrorCode } from "./contract";

const MAX_DAYS = 660;
const MAX_AWARDS = 256;
const MAX_SPENDS = 8;
const MAX_COMPONENTS = 10;
export const RULE_VERSION = 1;

interface WireDay {
  day: number; component: string;
  counters: DayComponent["counters"];
  zone: DayComponent["zone"];
  buckets: Bucket[];
}
interface WireAward { kind: string; dedupKey: string; points: number; dayLabel: string; bucket: number; everlasting?: boolean }
interface WireSpend { repairedDay: string; amount: number; monthKey: string; chargeBucket: number; refunded?: boolean }
interface WirePublish {
  schemaVersion: number; ruleVersion: number;
  frontier: Record<string, number>;
  days?: WireDay[]; awards?: WireAward[]; spends?: WireSpend[];
  registers?: Partial<Registers>;
}

const TOP_FIELDS = new Set(["schemaVersion", "ruleVersion", "frontier", "days", "awards", "spends", "registers"]);

export function dayU16Today(now = Date.now()): number { return Math.floor(now / 86_400_000); }

/** Retention/acceptance window start: first label of the previous calendar
 *  month (UTC reckoning) − 1 (algebra §6.1). */
export function windowStartU16(now = Date.now()): number {
  const d = new Date(now);
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  return Math.floor(first / 86_400_000) - 1;
}

export function labelOf(dayU16: number): string {
  return new Date(dayU16 * 86_400_000).toISOString().slice(0, 10);
}

function badZone(z: DayComponent["zone"]): boolean {
  return !z || typeof z.ianaZone !== "string" || z.ianaZone.length > 64
    || !Number.isInteger(z.offsetMin) || z.offsetMin < -720 || z.offsetMin > 840 || z.offsetMin % 15 !== 0;
}

export async function handlePublish(
  request: Request, env: Env, ctx: SessionContext,
): Promise<{ code: ErrorCode; data?: unknown }> {
  let body: WirePublish;
  try { body = await request.json(); } catch { return { code: "SCHEMA_INVALID" }; }
  if (Object.keys(body as unknown as Record<string, unknown>).some((k) => !TOP_FIELDS.has(k))) {
    return { code: "SCHEMA_UNKNOWN_FIELD" };
  }
  if (body.schemaVersion !== 1) return { code: "SCHEMA_VERSION_UNSUPPORTED" };
  if (body.ruleVersion !== RULE_VERSION) return { code: "SCHEMA_VERSION_UNSUPPORTED" };
  const days = body.days ?? [], awards = body.awards ?? [], spends = body.spends ?? [];
  const frontier = body.frontier ?? {};
  if (days.length > MAX_DAYS || awards.length > MAX_AWARDS || spends.length > MAX_SPENDS
    || Object.keys(frontier).length > MAX_COMPONENTS) return { code: "SCHEMA_INVALID" };

  const player = await env.SOCIAL_DB.prepare(
    "SELECT board_revision, folded_through, tz_zone FROM players WHERE player_id = ?")
    .bind(ctx.playerId).first();
  if (!player) return { code: "PROFILE_GONE" };

  const windowStart = Math.max(windowStartU16(), Number(player.folded_through));
  const maxDay = dayU16Today() + 1; // ≤ +1 calendar day of server UTC (SCORE-5c)
  const refusedStale: string[] = [];
  const accepted: Array<{ day: number; component: string; c: DayComponent; blob: Uint8Array; measure: number; hash: string }> = [];

  for (const w of days) {
    if (!Number.isInteger(w.day) || typeof w.component !== "string" || w.component.length > 64
      || !w.counters || badZone(w.zone) || !Array.isArray(w.buckets) || w.buckets.length > MAX_BUCKETS) {
      return { code: "SCHEMA_INVALID" };
    }
    if (w.day < windowStart) { refusedStale.push(labelOf(w.day)); continue; }
    if (w.day > maxDay) return { code: "SCHEMA_INVALID" };
    const c: DayComponent = { counters: w.counters, zone: w.zone, buckets: w.buckets };
    if (!bucketsConsistent(c)) return { code: "SCHEMA_INVALID" };
    if (envelopeViolation(c)) return { code: "PUBLISH_ENVELOPE_EXCEEDED" };
    let blob: Uint8Array;
    try { blob = encodeDayComponent(c); } catch { return { code: "SCHEMA_INVALID" }; }
    accepted.push({ day: w.day, component: w.component, c, blob, measure: measureOf(c), hash: await sha256Hex(blob) });
  }
  for (const a of awards) {
    if (typeof a.kind !== "string" || a.kind.length > 32 || typeof a.dedupKey !== "string" || a.dedupKey.length > 64
      || !Number.isInteger(a.points) || a.points < 0 || a.points > 4200
      || typeof a.dayLabel !== "string" || !Number.isInteger(a.bucket)) return { code: "SCHEMA_INVALID" };
  }
  for (const sp of spends) {
    if (typeof sp.repairedDay !== "string" || !Number.isInteger(sp.amount) || sp.amount < 0
      || typeof sp.monthKey !== "string" || !Number.isInteger(sp.chargeBucket)) return { code: "SCHEMA_INVALID" };
  }

  let changed = false;

  // ---- Commit A: projection shard — one guarded upsert per accepted row ----
  if (accepted.length) {
    const stmt = env.PROJECTION_1.prepare(
      `INSERT INTO day_state (player_id, day_u16, component_id, blob, measure, content_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (player_id, day_u16, component_id) DO UPDATE
       SET blob = excluded.blob, measure = excluded.measure, content_hash = excluded.content_hash
       WHERE excluded.measure > day_state.measure
          OR (excluded.measure = day_state.measure AND excluded.content_hash > day_state.content_hash)`);
    const results = await env.PROJECTION_1.batch(
      accepted.map((r) => stmt.bind(ctx.playerId, r.day, r.component, r.blob, r.measure, r.hash)));
    changed = results.some((r) => (r.meta?.changes ?? 0) > 0);
  }

  // ---- Commit B: SOCIAL_DB — registers (optimistic retry), awards, spends, duo ----
  const component = Object.keys(frontier)[0] ?? "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    const regRow = await env.SOCIAL_DB.prepare(
      "SELECT data, version FROM registers WHERE player_id = ?").bind(ctx.playerId).first();
    const stored: Registers = regRow?.data && (regRow.data as ArrayBuffer).byteLength > 0
      ? JSON.parse(new TextDecoder().decode(new Uint8Array(regRow.data as ArrayBuffer)))
      : structuredClone(EMPTY_REGISTERS);
    const incoming: Registers = { ...structuredClone(EMPTY_REGISTERS), ...(body.registers ?? {}) };
    let merged = joinRegisters(stored, incoming);
    for (const r of accepted) {
      const k = r.c.counters;
      if (k.sessionPts + k.wordPts + k.timePts > 0) {
        merged = { ...merged, ...setBit(merged, r.day) };
      }
    }
    const mergedText = JSON.stringify(merged);
    const regChanged = mergedText !== JSON.stringify(stored);

    const statements = [
      env.SOCIAL_DB.prepare(
        "UPDATE registers SET data = ?1, version = version + 1, updated_at = ?2 WHERE player_id = ?3 AND version = ?4")
        .bind(new TextEncoder().encode(mergedText), Date.now(), ctx.playerId, Number(regRow?.version ?? 0)),
    ];
    for (const a of awards) {
      statements.push(env.SOCIAL_DB.prepare(
        `INSERT INTO awards_window (player_id, kind, dedup_key, points, day_label, bucket, everlasting, source_component)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (player_id, kind, dedup_key) DO UPDATE
         SET points = excluded.points, day_label = excluded.day_label, bucket = excluded.bucket,
             source_component = excluded.source_component
         WHERE excluded.bucket < awards_window.bucket
            OR (excluded.bucket = awards_window.bucket AND excluded.source_component < awards_window.source_component)`)
        .bind(ctx.playerId, a.kind, a.dedupKey, a.points, a.dayLabel, a.bucket, a.everlasting ? 1 : 0, component));
    }
    for (const sp of spends) {
      statements.push(env.SOCIAL_DB.prepare(
        `INSERT INTO spends (player_id, repaired_day, amount, month_key, charge_bucket, refunded, source_component)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (player_id, repaired_day) DO UPDATE SET
           amount = CASE WHEN excluded.charge_bucket < spends.charge_bucket
                           OR (excluded.charge_bucket = spends.charge_bucket AND excluded.source_component < spends.source_component)
                    THEN excluded.amount ELSE spends.amount END,
           month_key = CASE WHEN excluded.charge_bucket < spends.charge_bucket
                           OR (excluded.charge_bucket = spends.charge_bucket AND excluded.source_component < spends.source_component)
                    THEN excluded.month_key ELSE spends.month_key END,
           charge_bucket = MIN(spends.charge_bucket, excluded.charge_bucket),
           refunded = MAX(spends.refunded, excluded.refunded)`)
        .bind(ctx.playerId, sp.repairedDay, sp.amount, sp.monthKey, sp.chargeBucket, sp.refunded ? 1 : 0, component));
    }
    const results = await env.SOCIAL_DB.batch(statements);
    const regWrote = (results[0].meta?.changes ?? 0) > 0;
    if (!regWrote) continue; // version raced — re-read and retry (bounded)
    changed = changed || regChanged
      || results.slice(1).some((r) => (r.meta?.changes ?? 0) > 0);

    // Duo minting (§3.2): friends whose bitmap shares a newly-earning label.
    await mintDuoReceipts(env, ctx.playerId, merged, accepted);
    break;
  }

  if (changed) {
    await env.SOCIAL_DB.prepare(
      "UPDATE players SET board_revision = board_revision + 1, updated_at = ?2 WHERE player_id = ?1")
      .bind(ctx.playerId, Date.now()).run();
  }

  return {
    code: "OK",
    data: {
      frontier, changed, refusedStale,
      revision: Number(player.board_revision) + (changed ? 1 : 0),
      serverTimeMs: Date.now(),
    },
  };
}

async function mintDuoReceipts(
  env: Env, playerId: string, merged: Registers,
  accepted: Array<{ day: number; c: DayComponent }>,
): Promise<void> {
  const earningDays = accepted.filter((r) => r.c.counters.sessionPts > 0).map((r) => r.day);
  if (!earningDays.length) return;
  const edges = await env.SOCIAL_DB.prepare(
    "SELECT a, b FROM friendships WHERE a = ?1 OR b = ?1 LIMIT 10").bind(playerId).all();
  const friends = (edges.results ?? []).map((e) => (e.a === playerId ? e.b : e.a) as string);
  if (!friends.length) return;
  const marks = friends.map(() => "?").join(",");
  const rows = await env.SOCIAL_DB.prepare(
    `SELECT player_id, data FROM registers WHERE player_id IN (${marks})`).bind(...friends).all();
  const statements: D1PreparedStatement[] = [];
  const t = Date.now();
  for (const row of rows.results ?? []) {
    const friendRegs: Registers = row.data && (row.data as ArrayBuffer).byteLength > 0
      ? JSON.parse(new TextDecoder().decode(new Uint8Array(row.data as ArrayBuffer)))
      : EMPTY_REGISTERS;
    const friendDays = bitsOf(friendRegs);
    for (const day of earningDays) {
      if (!friendDays.has(day)) continue;
      const label = labelOf(day);
      for (const side of [playerId, String(row.player_id)]) {
        statements.push(env.SOCIAL_DB.prepare(
          `INSERT OR IGNORE INTO duo_receipts (player_id, award_id, day_label, rule_version, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`)
          .bind(side, `duo:${label}`, label, RULE_VERSION, t));
      }
    }
  }
  if (statements.length) await env.SOCIAL_DB.batch(statements);
}
