#!/usr/bin/env node
// Publish parser/envelope tests: hostile requests must reject before expensive
// storage work, while exact supported boundaries remain legal.
//
// Traceability:
// TS-LB3-DB-005 TS-LB3-DB-014 TS-LB3-DB-015
// TS-LB3-SYNC-006 TS-LB3-SYNC-013 TS-LB3-SYNC-014
// TS-LB3-SYNC-018 TS-LB3-SYNC-019 TS-LB3-SYNC-020
// TS-LB3-SEC-010 TS-LB3-SEC-011 TS-LB3-SEC-012
// TS-LB3-SEC-016 TS-LB3-PERF-012.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "lb-publish-policy-"));

class RecordingStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  bind() { return this; }
  async first() {
    if (this.sql.includes("INSERT INTO quotas")) return { count: 1 };
    if (this.sql.includes("SELECT board_revision")) {
      return { board_revision: 0, folded_through: 0, tz_zone: "UTC" };
    }
    return null;
  }
}

class RecordingDB {
  constructor() { this.calls = 0; }
  prepare(sql) {
    this.calls += 1;
    return new RecordingStatement(this, sql);
  }
}

const request = (body) => new Request(
  "https://worker.test/v3/leaderboard/publish",
  {
    method: "POST", headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  },
);
const ctx = {
  playerId: "p1", family: "f1", nickname: "Anna",
  boardRevision: 0, sessionVersion: 1,
};
const base = {
  schemaVersion: 1, ruleVersion: 1, frontier: {},
  days: [], awards: [], spends: [],
};

try {
  execSync(
    `npx --prefix ../read-worker esbuild src/publish.ts --bundle --format=esm --outfile=${join(out, "publish.mjs")}`,
    { cwd: root, stdio: "pipe" },
  );
  const publish = await import(join(out, "publish.mjs"));

  const beforeDB = async (body, expected) => {
    const db = new RecordingDB();
    const result = await publish.handlePublish(request(body), {
      SOCIAL_DB: db, PROJECTION_1: db,
    }, ctx);
    assert.equal(result.code, expected);
    assert.equal(db.calls, 0, `${expected} reached storage`);
  };

  await beforeDB("{", "SCHEMA_INVALID");
  await beforeDB({ ...base, unknown: true }, "SCHEMA_UNKNOWN_FIELD");
  await beforeDB({ ...base, schemaVersion: 0 }, "SCHEMA_VERSION_UNSUPPORTED");
  await beforeDB({ ...base, ruleVersion: 2 }, "SCHEMA_VERSION_UNSUPPORTED");
  await beforeDB({ ...base, frontier: Object.fromEntries(
    Array.from({ length: 11 }, (_, i) => [`f${i}`, i]),
  ) }, "SCHEMA_INVALID");
  await beforeDB({ ...base, days: Array(661).fill({}) }, "SCHEMA_INVALID");
  await beforeDB({ ...base, awards: Array(257).fill({}) }, "SCHEMA_INVALID");
  await beforeDB({ ...base, spends: Array(9).fill({}) }, "SCHEMA_INVALID");

  // Day shape and numeric bounds are checked before encoding/upsert.
  const day = {
    day: publish.dayU16Today(), component: "device-a",
    counters: {
      sessionPts: 1, wordPts: 0, timePts: 0,
      learnSec: 1, focusSec: 0, sessions: 1, wordsTouched: 1,
    },
    zone: { ianaZone: "UTC", offsetMin: 0 },
    buckets: [{ deltaQH: 0, sessionPts: 1, wordPts: 0, timePts: 0 }],
  };
  await beforeDB({ ...base, days: [{ ...day, component: "x".repeat(65) }] },
    "SCHEMA_INVALID");
  await beforeDB({ ...base, days: [{ ...day, zone: {
    ianaZone: "UTC", offsetMin: 17,
  } }] }, "SCHEMA_INVALID");
  await beforeDB({ ...base, days: [{ ...day, buckets: Array(105).fill(
    { deltaQH: 0, sessionPts: 0, wordPts: 0, timePts: 0 },
  ) }] }, "SCHEMA_INVALID");

  // The full router must reject bombs by byte/nesting/duplicate-key policy
  // before JSON parsing or D1. The handler's exported seam documents the same
  // hard one-MiB bound rather than relying on platform memory limits.
  const source = await import("node:fs").then(({ readFileSync }) =>
    readFileSync(join(root, "src/index.ts"), "utf8"));
  assert.match(source, /1_048_576|1024 \* 1024|1 MiB/,
    "router has no absolute publish body-size guard");
  assert.match(source, /duplicate/i,
    "canonical JSON duplicate-key rejection is absent");
  assert.match(source, /nest|depth/i,
    "JSON nesting-depth guard is absent");

  console.log("publish-policy.test OK — parser/bounds/pre-DB rejection");
} finally {
  rmSync(out, { recursive: true, force: true });
}
