interface Env {
  DB: D1Database;
  API_KEY: string;
}

const ALLOWED_TABLES = new Set(["verbs", "nouns", "adverbs_adjectives"]);

// Max ids per DELETE statement — keeps bound parameters well under SQLite/D1 limits
const DELETE_CHUNK_SIZE = 100;

// Fixed column order per table — drives parameterised INSERT, never sourced from user input
const TABLE_COLUMNS: Record<string, string[]> = {
  verbs: [
    "id", "content_hash", "level", "capital", "type", "word", "english",
    "german_sentence", "english_sentence", "ich", "du", "er_sie_es",
    "wir", "ihr", "sie_sie", "past_participle", "simple_past",
  ],
  nouns: [
    "id", "content_hash", "level", "capital", "type", "article", "word",
    "plural", "image", "english", "german_sentence", "english_sentence",
  ],
  adverbs_adjectives: [
    "id", "content_hash", "level", "capital", "type", "word", "english",
    "german_sentence", "english_sentence", "comparative", "superlative",
  ],
};

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Verifies HMAC-SHA256 request signature and a 5-minute timestamp window.
// The raw API_KEY secret never travels over the wire — only the signed digest does.
async function verifyHmac(request: Request, env: Env): Promise<Response | null> {
  if (!env.API_KEY) {
    return json({ error: "server misconfigured: API_KEY secret not set" }, 500);
  }

  const timestamp = request.headers.get("X-Timestamp");
  const signature = request.headers.get("X-Signature");
  if (!timestamp || !signature) {
    return json({ error: "unauthorized" }, 401);
  }

  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > 300) {
    return json({ error: "unauthorized" }, 401);
  }

  const enc = new TextEncoder();

  // Clone so the original body stream remains readable by route handlers
  const bodyText = await request.clone().text();
  const bodyHash = bytesToHex(await crypto.subtle.digest("SHA-256", enc.encode(bodyText)));

  // Sign path + query only (e.g. "/sync/verbs") — never scheme/host/port — so
  // proxy or normalisation differences can't break verification. Must match the
  // client's signing input exactly (sync.py _sign_request).
  const sigUrl = new URL(request.url);
  const path = `${sigUrl.pathname}${sigUrl.search}`;
  const canonical = `${request.method}\n${path}\n${timestamp}\n${bodyHash}`;

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.API_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(canonical)));
  const providedBytes = hexToBytes(signature);

  if (
    providedBytes.length !== expectedBytes.length ||
    !crypto.subtle.timingSafeEqual(providedBytes, expectedBytes)
  ) {
    return json({ error: "unauthorized" }, 401);
  }

  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleGetState(table: string, env: Env): Promise<Response> {
  if (!ALLOWED_TABLES.has(table)) {
    return json({ error: "invalid table" }, 400);
  }
  try {
    const result = await env.DB.prepare(
      `SELECT id, content_hash FROM ${table}`
    ).all<{ id: string; content_hash: string }>();

    const state: Record<string, string> = {};
    for (const row of result.results) {
      state[row.id] = row.content_hash;
    }
    return json(state);
  } catch (err) {
    console.error("get_state failed", { table, err: String(err) });
    return json({ error: "database error" }, 500);
  }
}

type SyncRow = Record<string, unknown>;

interface SyncBody {
  upsert?: SyncRow[];
  delete?: string[];
}

async function handlePostSync(
  table: string,
  request: Request,
  env: Env
): Promise<Response> {
  if (!ALLOWED_TABLES.has(table)) {
    return json({ error: "invalid table" }, 400);
  }

  let body: SyncBody;
  try {
    body = await request.json<SyncBody>();
  } catch (err) {
    console.error("sync invalid JSON body", { table, err: String(err) });
    return json({ error: "invalid JSON body" }, 400);
  }

  if (!Array.isArray(body.upsert) || !Array.isArray(body.delete)) {
    return json({ error: "body must have upsert and delete arrays" }, 400);
  }

  const columns = TABLE_COLUMNS[table];
  const placeholders = columns.map(() => "?").join(", ");
  const updateSet = columns
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");

  const statements: D1PreparedStatement[] = [];

  for (const row of body.upsert) {
    const values = columns.map((col) => row[col] ?? null);
    statements.push(
      env.DB.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${updateSet}, updated_at = datetime('now')`
      ).bind(...values)
    );
  }

  // Chunk deletes into multiple statements so a large deletion never exceeds
  // SQLite/D1's bound-parameter limit on a single IN (...) clause.
  for (let i = 0; i < body.delete.length; i += DELETE_CHUNK_SIZE) {
    const idChunk = body.delete.slice(i, i + DELETE_CHUNK_SIZE);
    const idPlaceholders = idChunk.map(() => "?").join(", ");
    statements.push(
      env.DB.prepare(
        `DELETE FROM ${table} WHERE id IN (${idPlaceholders})`
      ).bind(...idChunk)
    );
  }

  if (statements.length === 0) {
    return json({ upserted: 0, deleted: 0 });
  }

  try {
    await env.DB.batch(statements);
    return json({ upserted: body.upsert.length, deleted: body.delete.length });
  } catch (err) {
    console.error("sync batch failed", {
      table,
      upserts: body.upsert.length,
      deletes: body.delete.length,
      err: String(err),
    });
    return json({ error: "database error" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const authResponse = await verifyHmac(request, env);
    if (authResponse) return authResponse;

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const [route, table] = parts;

    if (request.method === "GET" && route === "state" && table) {
      return handleGetState(table, env);
    }
    if (request.method === "POST" && route === "sync" && table) {
      return handlePostSync(table, request, env);
    }

    return json({ error: "not found" }, 404);
  },
};
