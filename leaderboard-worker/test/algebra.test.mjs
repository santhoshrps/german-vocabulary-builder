#!/usr/bin/env node
// W3 property tests over the pure algebra core (L1): codec roundtrip,
// measure monotonicity, F7 consistency, register join ACI + convergence,
// bitmap OR, viewer-boundary exactness and the generated envelope.
//
// Traceability:
// TS-LB3-BOARD-009 TS-LB3-BOARD-010 TS-LB3-BOARD-011
// TS-LB3-BOARD-012 TS-LB3-BOARD-014 TS-LB3-SYNC-005
// TS-LB3-SYNC-006 TS-LB3-SYNC-007 TS-LB3-SYNC-008
// TS-LB3-SYNC-009 TS-LB3-SYNC-011 TS-LB3-SYNC-013
// TS-LB3-SYNC-014 TS-LB3-SYNC-016 TS-LB3-SYNC-019
// TS-LB3-ECON-004 TS-LB3-ECON-007 TS-LB3-ECON-008.
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "lb-w3-"));
try {
  execSync(`npx --prefix ../read-worker esbuild src/algebra.ts --bundle --format=esm --outfile=${join(out, "a.mjs")}`, { cwd: root, stdio: "pipe" });
  const A = await import(join(out, "a.mjs"));

  // Deterministic PRNG (seed recorded — rerunnable)
  const SEED = 424242;
  let s = SEED;
  const rnd = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };

  // P: the specification requires at least 10,000 retained-seed histories.
  const HISTORIES = 10_000;
  for (let i = 0; i < HISTORIES; i++) {
    const buckets = Array.from({ length: rnd(20) }, () => ({
      deltaQH: rnd(104), sessionPts: rnd(200), wordPts: rnd(50), timePts: rnd(3),
    }));
    const c = {
      counters: {
        sessionPts: buckets.reduce((x, b) => x + b.sessionPts, 0),
        wordPts: buckets.reduce((x, b) => x + b.wordPts, 0),
        timePts: buckets.reduce((x, b) => x + b.timePts, 0),
        learnSec: rnd(7200), focusSec: rnd(7200), sessions: rnd(21), wordsTouched: rnd(100),
      },
      zone: { ianaZone: ["Europe/Berlin", "Pacific/Chatham", "Asia/Kathmandu", "America/New_York"][rnd(4)], offsetMin: [60, 765, 345, -300][rnd(4)] },
      buckets,
    };
    const decoded = A.decodeDayComponent(A.encodeDayComponent(c));
    assert.deepEqual(decoded, c);
    assert.ok(A.bucketsConsistent(c));
    // measure grows under any legal mutation
    const grown = structuredClone(c);
    grown.counters.sessionPts += 1;
    if (grown.buckets.length) grown.buckets[0].sessionPts += 1;
    assert.ok(A.measureOf(grown) > A.measureOf(c));
  }

  // P: truncated/trailing bytes reject
  const blob = A.encodeDayComponent({ counters: { sessionPts: 1, wordPts: 0, timePts: 0, learnSec: 0, focusSec: 0, sessions: 1, wordsTouched: 1 }, zone: { ianaZone: "UTC", offsetMin: 0 }, buckets: [{ deltaQH: 3, sessionPts: 1, wordPts: 0, timePts: 0 }] });
  assert.throws(() => A.decodeDayComponent(blob.slice(0, blob.length - 1)));
  assert.throws(() => A.decodeDayComponent(new Uint8Array([...blob, 0])));

  // P1/P2 (registers): random join orders converge byte-equal; join is ACI
  const regs = Array.from({ length: 6 }, (_, i) => ({
    streak: { v: rnd(50), asOf: `2026-07-${10 + rnd(15)}`, seq: rnd(9), fam: `f${rnd(4)}` },
    mastered: { v: rnd(500), asOf: `2026-07-${10 + rnd(15)}`, seq: rnd(9), fam: `f${rnd(4)}` },
    sup: { bd: rnd(900), bdk: `k${rnd(9)}`, bw: rnd(4000), bwk: `k${rnd(9)}`, bm: rnd(9000), bmk: `k${rnd(9)}` },
    seed: { earned: rnd(9999), seconds: rnd(99999), spent: rnd(100), refunded: rnd(50), basis: rnd(5) * 1000 },
    bitmapStart: 20000 + rnd(10), bitmap: ["01", "0f", "80", "ff03"][rnd(4)],
  }));
  const foldAll = (order) => order.reduce((acc, r) => A.joinRegisters(acc, r), A.EMPTY_REGISTERS);
  const base = JSON.stringify(foldAll(regs));
  const shuffledCopy = (values) => {
    const copy = [...values];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = rnd(i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  for (let trial = 0; trial < 10_000; trial++) {
    const shuffled = shuffledCopy(regs);
    const withDupes = [...shuffled, shuffled[rnd(shuffled.length)]];
    assert.equal(JSON.stringify(foldAll(withDupes)), base, "join order/duplication changed result");
  }
  const [x, y] = [regs[0], regs[1]];
  assert.equal(JSON.stringify(A.joinRegisters(x, y)), JSON.stringify(A.joinRegisters(y, x)));
  assert.equal(JSON.stringify(A.joinRegisters(x, x)), JSON.stringify(A.joinRegisters(A.EMPTY_REGISTERS, x)));

  // Bitmap OR
  const bm = A.joinBitmaps(
    { bitmapStart: 20000, bitmap: "01" },   // day 20000
    { bitmapStart: 20003, bitmap: "01" });  // day 20003
  assert.deepEqual([...A.bitsOf(bm)].sort(), [20000, 20003]);
  assert.deepEqual([...A.bitsOf(A.setBit(bm, 20001))].sort(), [20000, 20001, 20003]);

  // P8: boundary exactness — a bucket exactly AT a viewer midnight belongs to the
  // new period, one quarter-hour before belongs to the old, in every zone tried.
  for (const zone of ["Europe/Berlin", "Pacific/Chatham", "Asia/Kathmandu", "America/New_York", "Pacific/Kiritimati"]) {
    const ranges = A.viewerRanges(zone, new Date("2026-07-22T15:00:00Z")); // mid-week
    for (const range of [ranges.week, ranges.month]) {
      // boundary instants are quarter-hour aligned — the design's load-bearing fact
      assert.equal(range.startMs % A.QH_MS, 0, `${zone} start not QH-aligned`);
      assert.equal(range.endMs % A.QH_MS, 0, `${zone} end not QH-aligned`);
    }
    // synthetic earner in Berlin whose day straddles the viewer's week start
    const dayU16 = Math.floor(ranges.week.startMs / 86400000);
    const offsetMin = 120;
    const mk = (deltaQH) => ({
      counters: { sessionPts: 10, wordPts: 0, timePts: 0, learnSec: 0, focusSec: 0, sessions: 1, wordsTouched: 1 },
      zone: { ianaZone: "Europe/Berlin", offsetMin },
      buckets: [{ deltaQH, sessionPts: 10, wordPts: 0, timePts: 0 }],
    });
    const dayStart = A.dayStartMs(dayU16, offsetMin);
    const qhToBoundary = Math.round((ranges.week.startMs - dayStart) / A.QH_MS);
    if (qhToBoundary >= 1 && qhToBoundary < 104) {
      const before = A.componentPointsIn(mk(qhToBoundary - 1), dayU16, ranges.week).sessionPts;
      const atBoundary = A.componentPointsIn(mk(qhToBoundary), dayU16, ranges.week).sessionPts;
      assert.equal(before, 0, `${zone}: bucket before boundary leaked in`);
      assert.equal(atBoundary, 10, `${zone}: bucket at boundary excluded`);
    }
  }

  // DST weeks are exact, not merely "near seven days".
  const berlinSpring = A.viewerRanges("Europe/Berlin", new Date("2026-03-25T12:00:00Z"));
  assert.equal((berlinSpring.week.endMs - berlinSpring.week.startMs) / 3600000, 167);
  const berlinFall = A.viewerRanges("Europe/Berlin", new Date("2026-10-21T12:00:00Z"));
  assert.equal((berlinFall.week.endMs - berlinFall.week.startMs) / 3600000, 169);
  const kathmandu = A.viewerRanges("Asia/Kathmandu", new Date("2026-07-22T12:00:00Z"));
  assert.equal(kathmandu.week.startMs % A.QH_MS, 0);
  const chatham = A.viewerRanges("Pacific/Chatham", new Date("2026-07-22T12:00:00Z"));
  assert.equal(chatham.month.startMs % A.QH_MS, 0);

  // Exact legal boundary accepts; one over every bounded class rejects.
  const legalMaximum = {
    counters: {
      sessionPts: A.ENVELOPE_V1.sessionClassPerDay,
      wordPts: A.ENVELOPE_V1.wordClassPerDay,
      timePts: A.ENVELOPE_V1.timePerDay,
      learnSec: 20 * 3600, focusSec: 20 * 3600,
      sessions: 20, wordsTouched: 2_000,
    },
    zone: { ianaZone: "UTC", offsetMin: 0 },
    buckets: [],
  };
  assert.equal(A.envelopeViolation(legalMaximum), false);
  for (const field of ["sessionPts", "wordPts", "timePts"]) {
    const hostile = structuredClone(legalMaximum);
    hostile.counters[field] += 1;
    assert.equal(A.envelopeViolation(hostile), true, `${field} one-over accepted`);
  }

  console.log(`algebra.test OK (seed ${SEED}, ${HISTORIES} histories) — codec, ACI/convergence, bitmap, boundaries, DST, envelope`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
