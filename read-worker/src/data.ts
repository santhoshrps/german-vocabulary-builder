import { Env } from "./env";
import { utf8, sha256, bytesToHex } from "./bytes";
import { Scope } from "./entitlement";

export const TABLES = ["verbs", "nouns", "adverbs_adjectives"] as const;
export type TableName = (typeof TABLES)[number];

export function isTable(t: string): t is TableName {
  return (TABLES as readonly string[]).includes(t);
}

const ROWS_PER_REQUEST_CAP = 200;

// SQL fragment restricting a query to the caller's scope. Free sessions only
// ever see rows flagged free = 1; full sessions see everything. This is the
// server-side paywall: a free client literally cannot fetch beyond the preview.
function scopeWhere(scope: Scope): string {
  return scope === "free" ? "free = 1" : "1 = 1";
}

// Defense-in-depth: the content layer is read-only. Every statement in this file
// goes through this guard, which refuses anything that is not a SELECT — so an
// accidental write slipping into the content path in a future change fails loudly
// instead of mutating the shared vocabulary database.
function readOnlySelect(env: Env, sql: string): D1PreparedStatement {
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error(`content layer is read-only; refused non-SELECT: ${sql.trim().slice(0, 40)}`);
  }
  return env.DB.prepare(sql);
}

// ---- Dataset version --------------------------------------------------------
// Prefer an explicit value in meta.dataset_version (bumped by the write worker).
// Otherwise derive one from per-table COUNT(*) + MAX(updated_at): COUNT reflects
// deletions, MAX(updated_at) reflects inserts/updates — so any change moves it.
export async function getVersion(env: Env, scope: Scope): Promise<string> {
  // The version is scope-specific so a free->full upgrade always looks "changed"
  // to the client (and free users don't needlessly re-sync on full-only edits).
  const explicit = await readOnlySelect(env,
    "SELECT value FROM meta WHERE key = 'dataset_version'"
  ).first<{ value: string }>().catch(() => null);
  if (explicit?.value) return `${explicit.value}:${scope}`;

  const parts: string[] = [scope];
  for (const t of TABLES) {
    const row = await readOnlySelect(env,
      `SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), '') AS m FROM ${t} WHERE ${scopeWhere(scope)}`
    ).first<{ c: number; m: string }>();
    parts.push(`${t}:${row?.c ?? 0}:${row?.m ?? ""}`);
  }
  const hash = bytesToHex(await sha256(utf8(parts.join("|"))));
  return hash.slice(0, 16);
}

// ---- Manifest ---------------------------------------------------------------
// { table: { id: content_hash } } for client-side reconciliation (incl. deletes).
export async function getManifest(env: Env, scope: Scope): Promise<Record<string, Record<string, string>>> {
  const manifest: Record<string, Record<string, string>> = {};
  for (const t of TABLES) {
    const res = await readOnlySelect(env,`SELECT id, content_hash FROM ${t} WHERE ${scopeWhere(scope)}`)
      .all<{ id: string; content_hash: string }>();
    const map: Record<string, string> = {};
    for (const r of res.results) map[r.id] = r.content_hash;
    manifest[t] = map;
  }
  return manifest;
}

// ---- Rows -------------------------------------------------------------------
// Full rows for specific ids (the changed set from a manifest diff).
//
// D1 limits bound parameters to ~100 per query, so the id list is split into
// sub-batches well under that limit and merged — otherwise a full-tier delta
// sync (which requests up to ROWS_PER_REQUEST_CAP ids at once) would throw and
// surface as a 500.
const ROWS_BIND_CHUNK = 90;

export async function getRows(env: Env, table: TableName, ids: string[], scope: Scope): Promise<unknown[]> {
  const capped = ids.slice(0, ROWS_PER_REQUEST_CAP);
  if (capped.length === 0) return [];

  const rows: unknown[] = [];
  for (let i = 0; i < capped.length; i += ROWS_BIND_CHUNK) {
    const chunk = capped.slice(i, i + ROWS_BIND_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    // The scope filter is essential here too: a free client must not be able to
    // pull a full-tier row by guessing its id.
    const res = await readOnlySelect(env,
      `SELECT * FROM ${table} WHERE id IN (${placeholders}) AND ${scopeWhere(scope)}`
    ).bind(...chunk).all();
    rows.push(...res.results);
  }
  return rows;
}

export const ROWS_CAP = ROWS_PER_REQUEST_CAP;

// ---- Search -----------------------------------------------------------------
// Look up a word across all tables by its German text OR English translation.
// Unlike the sync endpoints this is deliberately NOT scope-filtered: it searches
// the WHOLE vocabulary so a free user can discover full-set words (the teaser).
// Each hit carries its table and `free` flag so the client can mark which results
// are part of full access and must NOT be added to the local store. Still a SELECT,
// so it goes through the same read-only guard.
export interface SearchHit {
  table: TableName;
  free: boolean;
  row: Record<string, unknown>;
}

const SEARCH_LIMIT_PER_TABLE = 25;

// Columns matched per table: the German word + English translation, PLUS each table's inflected /
// derived forms (search.md SE-FR-ACCESS-8) — verb conjugations (present, simple past, past
// participle), adjective/adverb comparative & superlative, and noun plural — so a learner who types
// an inflected form finds the base word. Column names are literals from this file (never user input),
// so they are safe to interpolate into the SQL; the query value itself is always bound.
const SEARCH_COLUMNS: Record<TableName, string[]> = {
  verbs: ["word", "english", "ich", "du", "er_sie_es", "wir", "ihr", "sie_sie", "simple_past", "past_participle"],
  nouns: ["word", "english", "plural"],
  adverbs_adjectives: ["word", "english", "comparative", "superlative"],
};

// German umlauts the search folds away so matching is diacritic-insensitive (search.md SE-FR-ACCESS-8):
// "Hauser" finds "Häuser", "groser" finds "größer". Each entry lists the upper- and lower-case form and
// the ASCII base. We fold ONLY these combining diacritics — exactly what the iOS client's
// `localizedStandardContains` does via Unicode diacritic-stripping — so local and backend search behave
// identically. ß is deliberately left untouched: it has no Unicode decomposition, so the client doesn't
// fold it either (folding it to "ss" here would make the backend more lenient than local).
const UMLAUT_FOLDS: ReadonlyArray<{ upper: string; lower: string; base: string }> = [
  { upper: "Ä", lower: "ä", base: "a" },
  { upper: "Ö", lower: "ö", base: "o" },
  { upper: "Ü", lower: "ü", base: "u" },
];

// Folds a value to its lowercased, umlaut-stripped form in JS (Unicode-aware `toLowerCase`).
function foldTerm(s: string): string {
  let out = s.toLowerCase();
  for (const { lower, base } of UMLAUT_FOLDS) out = out.split(lower).join(base);
  return out;
}

// The SQL expression that folds a column the same way as `foldTerm`. SQLite/D1 has no unaccent() and
// its LOWER() only lowercases ASCII, so we REPLACE both umlaut cases explicitly, then LOWER() for the
// remaining A–Z. `col` is a literal from SEARCH_COLUMNS (never user input), so it is safe to embed.
function foldedColumnSql(col: string): string {
  let expr = col;
  for (const { upper, lower, base } of UMLAUT_FOLDS) {
    expr = `REPLACE(REPLACE(${expr}, '${upper}', '${base}'), '${lower}', '${base}')`;
  }
  return `LOWER(${expr})`;
}

export async function searchWord(env: Env, query: string, type?: string): Promise<SearchHit[]> {
  const like = `%${foldTerm(query)}%`;

  // Optional logical type narrows which table(s) we search.
  let tables: TableName[] = [...TABLES];
  if (type === "verb") tables = ["verbs"];
  else if (type === "noun") tables = ["nouns"];
  else if (type === "adjective" || type === "adverb") tables = ["adverbs_adjectives"];

  const hits: SearchHit[] = [];
  for (const t of tables) {
    const cols = SEARCH_COLUMNS[t];
    const where = cols.map((c) => `${foldedColumnSql(c)} LIKE ?`).join(" OR ");
    const binds = cols.map(() => like);
    const res = await readOnlySelect(env,
      `SELECT * FROM ${t} WHERE ${where} LIMIT ${SEARCH_LIMIT_PER_TABLE}`
    ).bind(...binds).all<Record<string, unknown>>();
    for (const row of res.results) {
      // adverbs_adjectives holds both; an adjective/adverb filter narrows by its `type` column.
      if ((type === "adjective" || type === "adverb") && row.type !== type) continue;
      hits.push({ table: t, free: Number(row.free) === 1, row });
    }
  }
  return hits;
}

// ---- Snapshot ---------------------------------------------------------------
// Full dataset as NDJSON (one row per line). Cloudflare compresses the response;
// the phone streams + inserts line-by-line without buffering it all in memory.
export async function buildSnapshotNdjson(env: Env, scope: Scope): Promise<string> {
  const lines: string[] = [];
  for (const t of TABLES) {
    const res = await readOnlySelect(env,`SELECT * FROM ${t} WHERE ${scopeWhere(scope)}`).all();
    for (const row of res.results) {
      lines.push(JSON.stringify({ t, row }));
    }
  }
  return lines.join("\n") + "\n";
}
