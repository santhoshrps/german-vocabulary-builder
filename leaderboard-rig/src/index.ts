// Leaderboard capacity rig — throwaway harness worker (capacity-model.md §7).
//
// Measurement tooling only: exercises the byte and transaction SHAPES the contract
// declares (publish commit A/B, board read fan-out, composite ETag, dbstat sizing)
// against a scratch D1, so the capacity model's MEASURED columns can be filled.
// It implements no product behavior, no auth beyond a run token, and is deleted
// together with its database after the run (handbook §6).

export interface Env {
  SCRATCH_DB: D1Database;
  RIG_TOKEN: string; // throwaway per-run token, set via `wrangler secret put`
}

// --- packed bucket encoding (capacity-model.md §2: varint deltas + point classes) ---

function pushVarint(bytes: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
  bytes.push(v);
}

export interface BucketShape { buckets: number; sessionPts: number; wordPts: number; timePts: number; }

/** One day row's packed blob for a synthetic shape; returns real serialized bytes. */
export function packDayBlob(shape: BucketShape): Uint8Array {
  const bytes: number[] = [];
  pushVarint(bytes, 1); // component count (typical single-device)
  pushVarint(bytes, shape.buckets);
  for (let i = 0; i < shape.buckets; i++) {
    pushVarint(bytes, 4);                                        // deltaQH gap
    pushVarint(bytes, Math.ceil(shape.sessionPts / shape.buckets));
    pushVarint(bytes, i === 0 ? shape.wordPts : 0);
    pushVarint(bytes, i === 0 ? shape.timePts : 0);
  }
  return new Uint8Array(bytes);
}

// The three §3 cases (typical / declared-forecast / legal-envelope worst).
export const SHAPES: Record<string, BucketShape> = {
  typical: { buckets: 6, sessionPts: 240, wordPts: 30, timePts: 4 },
  declared: { buckets: 40, sessionPts: 2400, wordPts: 120, timePts: 12 },
  envelope: { buckets: 104, sessionPts: 6000, wordPts: 7000, timePts: 12 },
};

const enc = new TextEncoder();

async function etagOf(parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(JSON.stringify(parts)));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, rig: true });
    if (request.headers.get("x-rig-token") !== env.RIG_TOKEN) return json({ code: "AUTH" }, 401);

    try {
      // POST /seed?players=N&days=D&shape=typical|declared|envelope&start=S
      // Bulk-inserts synthetic rows. FREE-PLAN SAFE: one D1 batch = one subrequest and
      // free Workers allow ~50 subrequests/request, so statements are chunked into ≤ 90
      // per batch and a request refuses work that would exceed ~45 batches. The driver
      // calls this repeatedly (25 players/call) for large fleets.
      if (url.pathname === "/seed" && request.method === "POST") {
        const players = Number(url.searchParams.get("players") ?? 25);
        const days = Number(url.searchParams.get("days") ?? 66);
        const start = Number(url.searchParams.get("start") ?? 0);
        const shape = SHAPES[url.searchParams.get("shape") ?? "typical"] ?? SHAPES.typical;
        if (players * (days + 1) > 4000) return json({ code: "TOO_MANY_STATEMENTS" }, 400);
        const blob = packDayBlob(shape);
        const dayStmt = env.SCRATCH_DB.prepare(
          "INSERT OR REPLACE INTO day_state (player_id, day_u16, blob, measure) VALUES (?, ?, ?, ?)");
        const playerStmt = env.SCRATCH_DB.prepare(
          "INSERT OR REPLACE INTO players (player_id, board_revision) VALUES (?, 0)");
        const statements: D1PreparedStatement[] = [];
        for (let p = start; p < start + players; p++) {
          const id = `rig-${p.toString().padStart(7, "0")}`;
          statements.push(playerStmt.bind(id));
          for (let d = 0; d < days; d++) statements.push(dayStmt.bind(id, 20000 + d, blob, d + 1));
        }
        for (let i = 0; i < statements.length; i += 90) {
          await env.SCRATCH_DB.batch(statements.slice(i, i + 90));
        }
        return json({ seeded: players, days, blobBytes: blob.length,
                      batches: Math.ceil(statements.length / 90) });
      }

      // POST /friends?start=S&count=N&fleet=F — ring topology, 10 friends per player.
      // Same subrequest discipline: ≤ 90 statements per batch, bounded per request.
      if (url.pathname === "/friends" && request.method === "POST") {
        const start = Number(url.searchParams.get("start") ?? 0);
        const count = Number(url.searchParams.get("count") ?? 250);
        const fleet = Number(url.searchParams.get("fleet") ?? 5000);
        if (count * 5 > 4000) return json({ code: "TOO_MANY_STATEMENTS" }, 400);
        const stmt = env.SCRATCH_DB.prepare(
          "INSERT OR IGNORE INTO friendships (a, b) VALUES (?, ?)");
        const statements: D1PreparedStatement[] = [];
        for (let p = start; p < start + count; p++) {
          for (let k = 1; k <= 5; k++) {
            const q = (p + k) % fleet;
            const [a, b] = [`rig-${p.toString().padStart(7, "0")}`, `rig-${q.toString().padStart(7, "0")}`].sort();
            statements.push(stmt.bind(a, b));
          }
        }
        for (let i = 0; i < statements.length; i += 90) {
          await env.SCRATCH_DB.batch(statements.slice(i, i + 90));
        }
        return json({ ok: true, from: start, count });
      }

      // POST /publish?player=rig-0000001&shape=declared
      // The T2 shape: commit A (1–3 day-row joins) then commit B (register/revision).
      if (url.pathname === "/publish" && request.method === "POST") {
        const player = url.searchParams.get("player") ?? "rig-0000001";
        const shape = SHAPES[url.searchParams.get("shape") ?? "typical"] ?? SHAPES.typical;
        const blob = packDayBlob(shape);
        const day = 20000 + (Date.now() % 66);
        const t0 = Date.now();
        // Commit A — measure-compared upsert (join: greater measure wins wholesale).
        await env.SCRATCH_DB.batch([
          env.SCRATCH_DB.prepare(
            `INSERT INTO day_state (player_id, day_u16, blob, measure) VALUES (?, ?, ?, ?)
             ON CONFLICT (player_id, day_u16) DO UPDATE
             SET blob = excluded.blob, measure = excluded.measure
             WHERE excluded.measure > day_state.measure`).bind(player, day, blob, Date.now()),
        ]);
        // Commit B — registers + revision bump (SOCIAL_DB side of the two-commit publish).
        await env.SCRATCH_DB.batch([
          env.SCRATCH_DB.prepare(
            "UPDATE players SET board_revision = board_revision + 1 WHERE player_id = ?").bind(player),
          env.SCRATCH_DB.prepare(
            `INSERT INTO checkpoints (player_id, component_id, earned_folded) VALUES (?, 'c1', 0)
             ON CONFLICT (player_id, component_id) DO NOTHING`).bind(player),
        ]);
        return json({ ms: Date.now() - t0, changed: true });
      }

      // GET /board?viewer=rig-0000001 — edge lookup + ≤11 keyed fetches + composite ETag.
      if (url.pathname === "/board") {
        const viewer = url.searchParams.get("viewer") ?? "rig-0000001";
        const t0 = Date.now();
        const edges = await env.SCRATCH_DB.prepare(
          "SELECT a, b, generation FROM friendships WHERE a = ?1 OR b = ?1 LIMIT 10").bind(viewer).all();
        const ids = [viewer, ...(edges.results ?? []).map((r) =>
          (r.a === viewer ? r.b : r.a) as string)];
        const marks = ids.map(() => "?").join(",");
        const rows = await env.SCRATCH_DB.prepare(
          `SELECT player_id, board_revision FROM players WHERE player_id IN (${marks})`)
          .bind(...ids).all();
        const days = await env.SCRATCH_DB.prepare(
          `SELECT player_id, count(*) AS n, sum(length(blob)) AS bytes
           FROM day_state WHERE player_id IN (${marks}) GROUP BY player_id`)
          .bind(...ids).all();
        const etag = await etagOf([edges.results, rows.results]);
        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        return json({ ms: Date.now() - t0, rows: rows.results?.length, dayGroups: days.results?.length }, 200, { etag });
      }

      // GET /stats — row counts + blob bytes (the §3 MEASURED column source).
      // D1 forbids sqlite_master and PRAGMA reads (SQLITE_AUTH) — table names are fixed.
      if (url.pathname === "/stats") {
        const out: Record<string, unknown> = {};
        for (const name of ["day_state", "players", "checkpoints", "friendships"]) {
          try {
            const count = await env.SCRATCH_DB.prepare(`SELECT count(*) AS n FROM ${name}`).first();
            out[name] = count?.n;
          } catch (error) {
            out[name] = `ERR ${String(error)}`;
          }
        }
        try {
          out.dayStateBytes = (await env.SCRATCH_DB.prepare(
            "SELECT sum(length(blob)) AS bytes FROM day_state").first())?.bytes;
        } catch (error) {
          out.dayStateBytes = `ERR ${String(error)}`;
        }
        // Total database size incl. indexes comes from `wrangler d1 info` on the CLI side.
        return json(out);
      }

      // GET /plan?q=board|publish — EXPLAIN QUERY PLAN evidence (release artifact).
      if (url.pathname === "/plan") {
        const plans = {
          board: "SELECT a, b FROM friendships WHERE a = 'x' OR b = 'x' LIMIT 10",
          publish: "SELECT measure FROM day_state WHERE player_id = 'x' AND day_u16 = 1",
        } as const;
        const q = plans[(url.searchParams.get("q") ?? "board") as keyof typeof plans];
        const plan = await env.SCRATCH_DB.prepare(`EXPLAIN QUERY PLAN ${q}`).all();
        return json(plan.results);
      }

      return json({ code: "NOT_FOUND" }, 404);
    } catch (error) {
      return json({ code: "INTERNAL", message: String(error) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
