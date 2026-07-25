// Algebra v1.1 — pure core (batch W3): bucket codec, content measures, register
// joins, viewer-zone period math. Everything here is deterministic and
// side-effect-free; the property tests run against THIS module.
// Implements docs/generic/leaderboard/design/crdt-state-algebra.md.

// --- varint codec ------------------------------------------------------------

function pushVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
}

// --- day-component state (F1 + F7) ------------------------------------------

export interface Bucket { deltaQH: number; sessionPts: number; wordPts: number; timePts: number }

export interface DayComponent {
  counters: {
    sessionPts: number; wordPts: number; timePts: number;
    learnSec: number; focusSec: number; sessions: number; wordsTouched: number;
  };
  zone: { ianaZone: string; offsetMin: number };
  buckets: Bucket[]; // empty = legacy day (whole-day attribution rule)
}

export const MAX_BUCKETS = 104;
export const MAX_BLOB = 1024;

export function encodeDayComponent(c: DayComponent): Uint8Array {
  const out: number[] = [];
  const k = c.counters;
  for (const v of [k.sessionPts, k.wordPts, k.timePts, k.learnSec, k.focusSec, k.sessions, k.wordsTouched]) {
    pushVarint(out, v);
  }
  // offset in minutes, zigzag for the negative half of the world
  pushVarint(out, (c.zone.offsetMin << 1) ^ (c.zone.offsetMin >> 31));
  const zoneBytes = new TextEncoder().encode(c.zone.ianaZone);
  pushVarint(out, zoneBytes.length);
  out.push(...zoneBytes);
  pushVarint(out, c.buckets.length);
  for (const b of c.buckets) {
    pushVarint(out, b.deltaQH); pushVarint(out, b.sessionPts);
    pushVarint(out, b.wordPts); pushVarint(out, b.timePts);
  }
  if (out.length > MAX_BLOB) throw new Error("blob over cap");
  return new Uint8Array(out);
}

export function decodeDayComponent(bytes: Uint8Array): DayComponent {
  let i = 0;
  const varint = (): number => {
    let shift = 0, result = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error("truncated");
      const b = bytes[i++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 28) throw new Error("varint too long");
    }
  };
  const counters = {
    sessionPts: varint(), wordPts: varint(), timePts: varint(),
    learnSec: varint(), focusSec: varint(), sessions: varint(), wordsTouched: varint(),
  };
  const zz = varint();
  const offsetMin = (zz >>> 1) ^ -(zz & 1);
  const zoneLen = varint();
  if (i + zoneLen > bytes.length) throw new Error("truncated zone");
  const ianaZone = new TextDecoder().decode(bytes.slice(i, i + zoneLen));
  i += zoneLen;
  const bucketCount = varint();
  if (bucketCount > MAX_BUCKETS) throw new Error("bucket count over cap");
  const buckets: Bucket[] = [];
  for (let b = 0; b < bucketCount; b++) {
    buckets.push({ deltaQH: varint(), sessionPts: varint(), wordPts: varint(), timePts: varint() });
  }
  if (i !== bytes.length) throw new Error("trailing bytes");
  return { counters, zone: { ianaZone, offsetMin }, buckets };
}

/** Content measure (algebra §2): the sum of every monotone field — grows with
 *  every legal single-writer mutation; no wall clock anywhere. */
export function measureOf(c: DayComponent): number {
  const k = c.counters;
  let m = k.sessionPts + k.wordPts + k.timePts + k.learnSec + k.focusSec + k.sessions + k.wordsTouched;
  for (const b of c.buckets) m += b.sessionPts + b.wordPts + b.timePts;
  return m;
}

/** F7 consistency invariant (§3.7): bucket sums equal counters per class —
 *  required whenever buckets exist; legacy rows (no buckets) pass vacuously. */
export function bucketsConsistent(c: DayComponent): boolean {
  if (c.buckets.length === 0) return true;
  let s = 0, w = 0, t = 0;
  for (const b of c.buckets) { s += b.sessionPts; w += b.wordPts; t += b.timePts; }
  return s === c.counters.sessionPts && w === c.counters.wordPts && t === c.counters.timePts;
}

// --- viewer-zone period math (§3.7/§3.8) ------------------------------------

export const QH_MS = 15 * 60_000;

/** The local day's start instant in ms, from its u16 label + recorded offset. */
export function dayStartMs(dayU16: number, offsetMin: number): number {
  return dayU16 * 86_400_000 - offsetMin * 60_000;
}

/** A bucket's absolute start instant (quarter-hour lattice). */
export function bucketStartMs(dayU16: number, offsetMin: number, deltaQH: number): number {
  return dayStartMs(dayU16, offsetMin) + deltaQH * QH_MS;
}

export interface InstantRange { startMs: number; endMs: number } // half-open

/** Sum a component's points inside a viewer instant range: buckets by their
 *  start instant; legacy (bucketless) days wholly by the day's START instant
 *  (the registered legacy approximation rule). Duo doubling and the time clamp
 *  are applied by the caller across components. */
export function componentPointsIn(
  c: DayComponent, dayU16: number, range: InstantRange,
): { sessionPts: number; wordPts: number; timePts: number } {
  if (c.buckets.length === 0) {
    const start = dayStartMs(dayU16, c.zone.offsetMin);
    const inside = start >= range.startMs && start < range.endMs;
    return inside
      ? { sessionPts: c.counters.sessionPts, wordPts: c.counters.wordPts, timePts: c.counters.timePts }
      : { sessionPts: 0, wordPts: 0, timePts: 0 };
  }
  let s = 0, w = 0, t = 0;
  for (const b of c.buckets) {
    const at = bucketStartMs(dayU16, c.zone.offsetMin, b.deltaQH);
    if (at >= range.startMs && at < range.endMs) { s += b.sessionPts; w += b.wordPts; t += b.timePts; }
  }
  return { sessionPts: s, wordPts: w, timePts: t };
}

/** Viewer week (Mon-start) and month instant ranges for a zone at `now`. */
export function viewerRanges(zone: string, now: Date): { week: InstantRange; month: InstantRange } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  const y = Number(get("year")), m = Number(get("month")), d = Number(get("day"));
  // Walk the CALENDAR back to Monday / forward to next Monday, then take each
  // date's true local midnight — exact across DST because midnights are measured,
  // never derived by day arithmetic on instants.
  const date = (offsetDays: number): [number, number, number] => {
    const t = new Date(Date.UTC(y, m - 1, d + offsetDays));
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  };
  const [wy, wm, wd] = date(-weekdayIndex);
  const [ny, nm, nd] = date(7 - weekdayIndex);
  const week: InstantRange = {
    startMs: zonedMidnightMs(zone, wy, wm, wd),
    endMs: zonedMidnightMs(zone, ny, nm, nd),
  };
  const month: InstantRange = {
    startMs: zonedMidnightMs(zone, y, m, 1),
    endMs: m === 12 ? localMidnightNext(zone, y + 1, 1) : localMidnightNext(zone, y, m + 1),
  };
  return { week, month };
}

/** Exact instant of local midnight for a calendar date in a zone (handles DST
 *  and fractional offsets by measuring the zone's offset at that date). */
export function zonedMidnightMs(zone: string, y: number, m: number, d: number): number {
  // Start from the UTC midnight guess, then correct by the zone's offset at that instant,
  // then re-correct once (offset can change across the correction — DST edge).
  let guess = Date.UTC(y, m - 1, d);
  for (let pass = 0; pass < 2; pass++) {
    guess = Date.UTC(y, m - 1, d) - offsetAt(zone, guess);
  }
  return guess;
}

function localMidnightNext(zone: string, y: number, m: number): number {
  return zonedMidnightMs(zone, y, m, 1);
}

export function offsetAt(zone: string, atMs: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(atMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

// --- registers (F5/F6) -------------------------------------------------------

export interface Registers {
  streak: { v: number; asOf: string; seq: number; fam: string };
  mastered: { v: number; asOf: string; seq: number; fam: string };
  sup: { bd: number; bdk: string; bw: number; bwk: string; bm: number; bmk: string };
  seed: { earned: number; seconds: number; spent: number; refunded: number; basis: number };
  bitmapStart: number;        // day_u16 of bit 0
  bitmap: string;             // hex, one bit per retained label
}

export const EMPTY_REGISTERS: Registers = {
  streak: { v: 0, asOf: "", seq: 0, fam: "" },
  mastered: { v: 0, asOf: "", seq: 0, fam: "" },
  sup: { bd: 0, bdk: "", bw: 0, bwk: "", bm: 0, bmk: "" },
  seed: { earned: 0, seconds: 0, spent: 0, refunded: 0, basis: 0 },
  bitmapStart: 0,
  bitmap: "",
};

function lwwWins(a: { asOf: string; seq: number; fam: string }, b: { asOf: string; seq: number; fam: string }): boolean {
  if (a.asOf !== b.asOf) return a.asOf > b.asOf;
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.fam > b.fam;
}

/** Join both registers states — ACI by construction (LWW total order, MAX,
 *  greater-basis seed, OR bitmap). */
export function joinRegisters(a: Registers, b: Registers): Registers {
  const sup = {
    bd: Math.max(a.sup.bd, b.sup.bd), bdk: a.sup.bd >= b.sup.bd ? (a.sup.bd === b.sup.bd ? minKey(a.sup.bdk, b.sup.bdk) : a.sup.bdk) : b.sup.bdk,
    bw: Math.max(a.sup.bw, b.sup.bw), bwk: a.sup.bw >= b.sup.bw ? (a.sup.bw === b.sup.bw ? minKey(a.sup.bwk, b.sup.bwk) : a.sup.bwk) : b.sup.bwk,
    bm: Math.max(a.sup.bm, b.sup.bm), bmk: a.sup.bm >= b.sup.bm ? (a.sup.bm === b.sup.bm ? minKey(a.sup.bmk, b.sup.bmk) : a.sup.bmk) : b.sup.bmk,
  };
  return {
    streak: lwwWins(a.streak, b.streak) ? a.streak : b.streak,
    mastered: lwwWins(a.mastered, b.mastered) ? a.mastered : b.mastered,
    sup,
    seed: a.seed.basis === b.seed.basis
      ? (seedHash(a.seed) >= seedHash(b.seed) ? a.seed : b.seed)
      : (a.seed.basis > b.seed.basis ? a.seed : b.seed),
    ...joinBitmaps(a, b),
  };
}

function minKey(x: string, y: string): string {
  if (!x) return y; if (!y) return x; return x < y ? x : y;
}

function seedHash(s: Registers["seed"]): string {
  return `${s.earned}:${s.seconds}:${s.spent}:${s.refunded}`;
}

export function joinBitmaps(a: Registers, b: Registers): { bitmapStart: number; bitmap: string } {
  if (!a.bitmap) return { bitmapStart: b.bitmapStart, bitmap: b.bitmap };
  if (!b.bitmap) return { bitmapStart: a.bitmapStart, bitmap: a.bitmap };
  const start = Math.min(a.bitmapStart, b.bitmapStart);
  const bitsA = bitsOf(a), bitsB = bitsOf(b);
  const all = new Set([...bitsA, ...bitsB]);
  const days = [...all].sort((x, y) => x - y);
  const end = days.length ? days[days.length - 1] : start;
  const len = Math.max(0, end - start + 1);
  const bytes = new Uint8Array(Math.ceil(len / 8));
  for (const day of days) {
    const bit = day - start;
    bytes[bit >> 3] |= 1 << (bit & 7);
  }
  return { bitmapStart: start, bitmap: [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("") };
}

export function bitsOf(r: { bitmapStart: number; bitmap: string }): Set<number> {
  const out = new Set<number>();
  for (let byte = 0; byte * 2 < r.bitmap.length; byte++) {
    const v = parseInt(r.bitmap.slice(byte * 2, byte * 2 + 2), 16);
    for (let bit = 0; bit < 8; bit++) if (v & (1 << bit)) out.add(r.bitmapStart + byte * 8 + bit);
  }
  return out;
}

export function setBit(r: { bitmapStart: number; bitmap: string }, day: number): { bitmapStart: number; bitmap: string } {
  const single = { bitmapStart: day, bitmap: "01" };
  return joinBitmaps(
    { ...EMPTY_REGISTERS, ...r },
    { ...EMPTY_REGISTERS, ...single },
  );
}

// --- scoring envelope v1 (generated from scoring-reference.md §4) ------------

export const ENVELOPE_V1 = {
  sessionClassPerDay: 6_000,   // E1–E4 (undoubled — doubling is a read rule)
  wordClassPerDay: 7_000,      // E5 (3,000) + E6 (4,000)
  timePerDay: 12,              // E7
  awardsPerDay: 8_075,         // E9..E18 rows: 50+5+450+2400+275+250+95+25+300+4200
  dailyCeiling: 27_062,
} as const;

export function envelopeViolation(c: DayComponent): boolean {
  const k = c.counters;
  return k.sessionPts > ENVELOPE_V1.sessionClassPerDay
    || k.wordPts > ENVELOPE_V1.wordClassPerDay
    || k.timePts > ENVELOPE_V1.timePerDay;
}
