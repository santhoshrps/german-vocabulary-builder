import { Env } from "./env";
import { contentQuery } from "./db";
import { utf8, sha256, bytesToHex } from "./bytes";
import { Scope } from "./entitlement";
import { DEFAULT_LANG, resolveChain } from "./languages";

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
  return scope === "free" ? "c.free = 1" : "1 = 1";
}

// The content database is read-only for this worker; the capability in src/db.ts
// enforces SELECT-only and is the sole holder of the binding (MS2-FR-29b).
function readOnlySelect(env: Env, sql: string): D1PreparedStatement {
  return contentQuery(env, sql);
}

// ---- Served shape (v2 schema, v1-compatible wire format) --------------------
//
// SCHEMA v2 (WD-ID/LG-FR-9): core tables carry German + sense; source-language
// text lives in `translations`, one row per word × language. The WIRE SHAPE stays
// v1-compatible on purpose (forward-compat floor, MS2-FR-23): every served row
// still carries `english` / `english_sentence` — filled with the REQUESTED
// language resolved through its fallback chain (?lang=es-MX → es-MX → es-419 →
// en, LG-FR-12/13). Today's app builds keep working untouched; a Chinese user's
// rows simply arrive with Chinese text in those fields. Additive v2 fields
// (`sense`, `translation_article`, `translation_article_plural`,
// `translation_plural`) ride along; old clients ignore them.
//
// The served `content_hash` is COMPOSITE: core hash + the chain's translation
// hashes. The manifest uses the same expression, so a translation edit changes
// exactly that word's hash and the normal delta machinery ships it — and a
// language switch changes every hash, which IS the full re-fetch the switch
// needs (ContentSyncCoordinator.resyncForSourceLanguageChange).

const CORE_COLUMNS: Record<TableName, string[]> = {
  verbs: [
    "id", "free", "level", "capital", "type", "word", "sense", "german_sentence",
    "ich", "du", "er_sie_es", "wir", "ihr", "sie_sie", "past_participle",
    "simple_past", "updated_at",
  ],
  nouns: [
    "id", "free", "level", "capital", "type", "article", "word", "plural",
    "sense", "image", "german_sentence", "updated_at",
  ],
  adverbs_adjectives: [
    "id", "free", "level", "capital", "type", "word", "sense", "german_sentence",
    "comparative", "superlative", "updated_at",
  ],
};

interface Overlay {
  select: string;      // full SELECT list (core columns + resolved language fields)
  joins: string;       // LEFT JOINs for the chain
  joinBinds: string[]; // one bind per chain entry (the language codes)
  hashExpr: string;    // the composite content_hash expression
  englishExpr: string; // resolved translation word (for search)
}

function buildOverlay(table: TableName, chain: string[]): Overlay {
  const joins = chain
    .map((_, i) => `LEFT JOIN translations t${i} ON t${i}.word_id = c.id AND t${i}.lang = ?`)
    .join(" ");
  const co = (field: string) =>
    chain.length === 1
      ? `t0.${field}`
      : `COALESCE(${chain.map((_, i) => `t${i}.${field}`).join(", ")})`;
  const hashExpr = [
    "c.content_hash",
    ...chain.map((_, i) => `COALESCE(t${i}.content_hash, '')`),
  ].join(" || ':' || ");
  const select = [
    ...CORE_COLUMNS[table].map((c) => `c.${c}`),
    `${hashExpr} AS content_hash`,
    `${co("word")} AS english`,
    `${co("sentence")} AS english_sentence`,
    `${co("article")} AS translation_article`,
    `${co("article_plural")} AS translation_article_plural`,
    `${co("plural")} AS translation_plural`,
  ].join(", ");
  return { select, joins, joinBinds: [...chain], hashExpr, englishExpr: co("word") };
}

export { resolveChain, DEFAULT_LANG };

// ---- Dataset version --------------------------------------------------------
// Prefer an explicit value in meta.dataset_version (bumped by the publish pipeline).
// Otherwise derive one from per-table COUNT(*) + MAX(updated_at) — including the
// translations and id_aliases tables, so ANY content edit moves the version.
// Language-independent by design: a change in one language bumps everyone's
// version, and the per-language manifest then limits actual transfer to the
// rows whose composite hash really changed (a no-op diff for the others).

// Per-isolate cache of the computed version, per scope. getVersion() runs at the top of EVERY
// data request (it keys the edge cache) and /v1/version is each client's foreground poll —
// without this, D1 QPS scales with USER count instead of with how often the data changes.
// The TTL matches /v1/version's public max-age (30s), so clients observe no extra staleness.
const VERSION_CACHE_TTL_MS = 30_000;
const versionCache = new Map<Scope, { version: string; expiresAt: number }>();

const VERSIONED_EXTRA_TABLES = ["translations", "id_aliases"] as const;

export async function getVersion(env: Env, scope: Scope): Promise<string> {
  const cached = versionCache.get(scope);
  const nowMs = Date.now();
  if (cached && cached.expiresAt > nowMs) return cached.version;

  // The version is scope-specific so a free->full upgrade always looks "changed"
  // to the client (and free users don't needlessly re-sync on full-only edits).
  const explicit = await readOnlySelect(env,
    "SELECT value FROM meta WHERE key = 'dataset_version'"
  ).first<{ value: string }>().catch(() => null);

  let version: string;
  if (explicit?.value) {
    version = `${explicit.value}:${scope}`;
  } else {
    const parts: string[] = [scope];
    for (const t of TABLES) {
      const row = await readOnlySelect(env,
        `SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), '') AS m FROM ${t} AS c WHERE ${scopeWhere(scope)}`
      ).first<{ c: number; m: string }>();
      parts.push(`${t}:${row?.c ?? 0}:${row?.m ?? ""}`);
    }
    for (const t of VERSIONED_EXTRA_TABLES) {
      const row = await readOnlySelect(env,
        `SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), '') AS m FROM ${t}`
      ).first<{ c: number; m: string }>();
      parts.push(`${t}:${row?.c ?? 0}:${row?.m ?? ""}`);
    }
    const hash = bytesToHex(await sha256(utf8(parts.join("|"))));
    version = hash.slice(0, 16);
  }

  versionCache.set(scope, { version, expiresAt: nowMs + VERSION_CACHE_TTL_MS });
  return version;
}

// ---- Manifest ---------------------------------------------------------------
// { table: { id: composite_hash } } for client-side reconciliation (incl. deletes).
// The hash is language-resolved (see the served-shape note above), so the caller's
// chain is part of the manifest identity — cache tags carry it.
export async function getManifest(
  env: Env, scope: Scope, chain: string[]
): Promise<Record<string, Record<string, string>>> {
  const manifest: Record<string, Record<string, string>> = {};
  for (const t of TABLES) {
    const o = buildOverlay(t, chain);
    const res = await readOnlySelect(env,
      `SELECT c.id AS id, ${o.hashExpr} AS content_hash FROM ${t} c ${o.joins} WHERE ${scopeWhere(scope)}`
    ).bind(...o.joinBinds).all<{ id: string; content_hash: string }>();
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
const ROWS_BIND_CHUNK = 80;

export async function getRows(
  env: Env, table: TableName, ids: string[], scope: Scope, chain: string[]
): Promise<unknown[]> {
  const capped = ids.slice(0, ROWS_PER_REQUEST_CAP);
  if (capped.length === 0) return [];

  const o = buildOverlay(table, chain);
  const rows: unknown[] = [];
  for (let i = 0; i < capped.length; i += ROWS_BIND_CHUNK) {
    const chunk = capped.slice(i, i + ROWS_BIND_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    // The scope filter is essential here too: a free client must not be able to
    // pull a full-tier row by guessing its id.
    const res = await readOnlySelect(env,
      `SELECT ${o.select} FROM ${table} c ${o.joins} ` +
      `WHERE c.id IN (${placeholders}) AND ${scopeWhere(scope)}`
    ).bind(...o.joinBinds, ...chunk).all();
    rows.push(...res.results);
  }
  return rows;
}

export const ROWS_CAP = ROWS_PER_REQUEST_CAP;

// ---- Search -----------------------------------------------------------------
// Look up a word across all tables by its German text OR its translation in the
// caller's language (resolved chain). Unlike the sync endpoints this is
// deliberately NOT scope-filtered: it searches the WHOLE vocabulary so a free
// user can discover full-set words (the teaser). Each hit carries its table and
// `free` flag so the client can mark which results are part of full access and
// must NOT be added to the local store. Still a SELECT, so it goes through the
// same read-only guard.
export interface SearchHit {
  table: TableName;
  free: boolean;
  row: Record<string, unknown>;
}

const SEARCH_LIMIT_PER_TABLE = 25;

// German columns matched per table: the word PLUS each table's inflected / derived forms
// (search.md SE-FR-ACCESS-8) — verb conjugations, adjective/adverb comparative &
// superlative, noun plural — so a learner who types an inflected form finds the base
// word. The TRANSLATION side matches the resolved language expression (LG-FR-13), not a
// column. Column names are literals from this file (never user input), so they are safe
// to interpolate into the SQL; the query value itself is always bound.
const SEARCH_FORM_COLUMNS: Record<TableName, string[]> = {
  verbs: ["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie", "simple_past", "past_participle"],
  nouns: ["plural"],
  adverbs_adjectives: ["comparative", "superlative"],
};

// German umlauts the search folds away so matching is diacritic-insensitive (search.md
// SE-FR-ACCESS-8): "Hauser" finds "Häuser". Each entry lists the upper- and lower-case
// form and the ASCII base. We fold ONLY these combining diacritics — exactly what the iOS
// client's `localizedStandardContains` does via Unicode diacritic-stripping — so local and
// backend search behave identically. ß is deliberately left untouched: it has no Unicode
// decomposition, so the client doesn't fold it either. (Per-language folding rules join
// the language registry with LG-FR-15; today's set serves German + the Latin-script
// translation languages, and CJK text passes through unfolded, which is correct.)
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

// The SQL expression that folds a column (or expression) the same way as `foldTerm`.
// SQLite/D1 has no unaccent() and its LOWER() only lowercases ASCII, so we REPLACE both
// umlaut cases explicitly, then LOWER() for the remaining A–Z. `col` is a literal from
// this file (never user input), so it is safe to embed.
function foldedColumnSql(col: string): string {
  let expr = col;
  for (const { upper, lower, base } of UMLAUT_FOLDS) {
    expr = `REPLACE(REPLACE(${expr}, '${upper}', '${base}'), '${lower}', '${base}')`;
  }
  return `LOWER(${expr})`;
}

export async function searchWord(
  env: Env, query: string, type: string | undefined, chain: string[]
): Promise<SearchHit[]> {
  const folded = foldTerm(query);
  const like = `%${folded}%`;      // German: match anywhere in the word/forms
  const prefix = `${folded}%`;     // starts-with
  const suffix = `%${folded}`;     // ends-with

  // Optional logical type narrows which table(s) we search.
  let tables: TableName[] = [...TABLES];
  if (type === "verb") tables = ["verbs"];
  else if (type === "noun") tables = ["nouns"];
  else if (type === "adjective" || type === "adverb") tables = ["adverbs_adjectives"];

  const hits: SearchHit[] = [];
  for (const t of tables) {
    const o = buildOverlay(t, chain);
    const wordSql = foldedColumnSql("c.word");
    const englishSql = foldedColumnSql(`COALESCE(${o.englishExpr}, '')`);
    // Word-boundary matching for the translation AND inflected forms: pad with spaces and
    // look for " query" / "query " / " query " — so "hund" won't match "t·hund·er", while
    // "dog" still finds "hot dog" (search.md SE-FR-ACCESS-3/8).
    const engPadded = `(' ' || ${englishSql} || ' ')`;
    const engStarts = `% ${folded}%`;
    const engEnds = `%${folded} %`;
    const wholeWord = `% ${folded} %`;

    const inflPadded = SEARCH_FORM_COLUMNS[t]
      .map((c) => `(' ' || ${foldedColumnSql(`COALESCE(c.${c}, '')`)} || ' ')`);

    // MATCHING: the base WORD matches anywhere (compounds like See·hund); inflected forms
    // and the translation match only at a WORD boundary.
    const whereParts = [
      `${wordSql} LIKE ?`,
      ...inflPadded.map((p) => `${p} LIKE ?`),
      `${engPadded} LIKE ?`,
      `${engPadded} LIKE ?`,
    ];
    const whereBinds = [like, ...inflPadded.map(() => wholeWord), engStarts, engEnds];

    // Rank so the per-table LIMIT keeps the BEST candidates (rank-then-limit,
    // SE-FR-ACCESS-9): word exact → whole inflected form → word starts/ends → word
    // mid-word → translation whole word → (else = translation word start/end).
    const wholeForm = inflPadded.length ? inflPadded.map((p) => `${p} LIKE ?`).join(" OR ") : null;
    const orderBy =
      "ORDER BY CASE" +
      ` WHEN ${wordSql} = ? THEN 0` +
      (wholeForm ? ` WHEN ${wholeForm} THEN 1` : "") +
      ` WHEN ${wordSql} LIKE ? OR ${wordSql} LIKE ? THEN 2` +
      ` WHEN ${wordSql} LIKE ? THEN 3` +
      ` WHEN ${engPadded} LIKE ? THEN 4` +
      " ELSE 5 END, LENGTH(c.word)";
    const orderBinds = [
      folded,
      ...inflPadded.map(() => wholeWord),
      prefix, suffix,
      like,
      wholeWord,
    ];

    const res = await readOnlySelect(env,
      `SELECT ${o.select} FROM ${t} c ${o.joins} ` +
      `WHERE ${whereParts.join(" OR ")} ${orderBy} LIMIT ${SEARCH_LIMIT_PER_TABLE}`
    ).bind(...o.joinBinds, ...whereBinds, ...orderBinds).all<Record<string, unknown>>();
    for (const row of res.results) {
      // adverbs_adjectives holds both; an adjective/adverb filter narrows by its `type` column.
      if ((type === "adjective" || type === "adverb") && row.type !== type) continue;
      hits.push({ table: t, free: Number(row.free) === 1, row });
    }
  }
  return hits;
}

// ---- Identity aliases -------------------------------------------------------
// The v1 -> v2 re-key map (WD-ID-4/5), served whole: ~12k tiny rows, one edge-
// cached fetch per dataset version per client. The app applies it after every
// sync (ONGOING, not one-time — late sheet fixes still re-attach progress).
export async function getAliases(env: Env): Promise<{ old: string; new: string; reason: string }[]> {
  const res = await readOnlySelect(env,
    'SELECT id AS old_id, new_id, reason FROM id_aliases'
  ).all<{ old_id: string; new_id: string; reason: string }>();
  return res.results.map((r) => ({ old: r.old_id, new: r.new_id, reason: r.reason }));
}

// (Search-usage accounting lives in limits.ts — it writes to the OPS database;
// this file is the content layer and holds no write path at all. MS2-FR-29b.)

// ---- Snapshot ---------------------------------------------------------------
// Full dataset as NDJSON (one row per line), language-resolved like every other
// read. Cloudflare compresses the response; the phone streams + inserts
// line-by-line without buffering it all in memory.
export async function buildSnapshotNdjson(
  env: Env, scope: Scope, chain: string[]
): Promise<string> {
  const lines: string[] = [];
  for (const t of TABLES) {
    const o = buildOverlay(t, chain);
    const res = await readOnlySelect(env,
      `SELECT ${o.select} FROM ${t} c ${o.joins} WHERE ${scopeWhere(scope)}`
    ).bind(...o.joinBinds).all();
    for (const row of res.results) {
      lines.push(JSON.stringify({ t, row }));
    }
  }
  return lines.join("\n") + "\n";
}
