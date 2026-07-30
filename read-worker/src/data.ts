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

async function wireContentHash(descriptor: unknown): Promise<string> {
  return bytesToHex(await sha256(utf8(String(descriptor ?? ""))));
}

async function normalizeWireRow(
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return { ...row, content_hash: await wireContentHash(row.content_hash) };
}

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

export interface SnapshotBlockMetadata {
  id: string;
  table: TableName;
  index: number;
  row_count: number;
  compressed_bytes: number;
  uncompressed_bytes: number;
  checksum: string;
}

export interface SnapshotManifest {
  contract_version: 1;
  snapshot_id: string;
  /** Publication cursor attached by the read API. It is deliberately excluded
   * from the immutable manifest checksum because publication assigns it only
   * when the uploaded manifest is committed. */
  sequence: number;
  dataset_generation: number;
  base_version: string;
  version: string;
  language: string;
  scope: Scope;
  schema_version: number;
  compression: "zlib";
  total_count: number;
  table_counts: {
    verbs: number;
    nouns: number;
    adverbs_adjectives: number;
  };
  global_fingerprint: string;
  block_count: number;
  total_compressed_bytes: number;
  total_uncompressed_bytes: number;
  blocks: SnapshotBlockMetadata[];
  manifest_checksum: string;
}

export interface SnapshotBlockPayload {
  metadata: SnapshotBlockMetadata;
  payload: Uint8Array;
}

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

export interface VocabularyTableCounts {
  verbs: number;
  nouns: number;
  adverbs_adjectives: number;
}

export interface VocabularyVersionView {
  sequence: number;
  datasetGeneration: number;
  version: string;
  scope: Scope;
  language: string;
  fingerprint: string;
  counts: VocabularyTableCounts;
}

type VersionViewRow = {
  sequence: number;
  dataset_generation: number;
  version: string;
  scope: Scope;
  language: string;
  fingerprint: string;
  verbs_count: number;
  nouns_count: number;
  adverbs_adjectives_count: number;
};

function mapVersionView(row: VersionViewRow): VocabularyVersionView {
  return {
    sequence: Number(row.sequence),
    datasetGeneration: Number(row.dataset_generation),
    version: row.version,
    scope: row.scope,
    language: row.language,
    fingerprint: row.fingerprint,
    counts: {
      verbs: Number(row.verbs_count),
      nouns: Number(row.nouns_count),
      adverbs_adjectives: Number(row.adverbs_adjectives_count),
    },
  };
}

async function versionViewFor(
  env: Env,
  scope: Scope,
  language: string,
  version?: string,
): Promise<VocabularyVersionView | null> {
  const versionPredicate = version ? "vv.version = ?" : (
    "vv.sequence = CAST((SELECT value FROM meta WHERE key = 'dataset_sequence') AS INTEGER)"
  );
  const statement = readOnlySelect(env,
    `SELECT vv.sequence, v.dataset_generation, vv.version, vv.scope, vv.language,
            vv.fingerprint, vv.verbs_count, vv.nouns_count,
            vv.adverbs_adjectives_count
       FROM vocabulary_version_views vv
       JOIN vocabulary_versions v ON v.sequence = vv.sequence
      WHERE vv.scope = ? AND vv.language = ? AND ${versionPredicate}
      LIMIT 1`
  );
  const row = version
    ? await statement.bind(scope, language, version).first<VersionViewRow>()
    : await statement.bind(scope, language).first<VersionViewRow>();
  return row ? mapVersionView(row) : null;
}

/// Transactional cursor metadata published beside the canonical rows. Older
/// databases legitimately have no history yet; callers then use the legacy
/// version/manifest recovery path until the publisher installs a baseline.
export async function getVersionView(
  env: Env,
  scope: Scope,
  chain: string[],
): Promise<VocabularyVersionView | null> {
  return versionViewFor(env, scope, chain[0] ?? DEFAULT_LANG).catch(() => null);
}

export type VocabularyChangeFeedWire = {
  contract_version: number;
  from_version: string;
  to_version: string;
  from_sequence: number;
  to_sequence: number;
  change_set_count: number;
  dataset_generation: number;
  language: string;
  scope: Scope;
  from_fingerprint: string;
  target_fingerprint: string;
  from_counts: VocabularyTableCounts;
  target_counts: VocabularyTableCounts;
  changed_count: number;
  deleted_count: number;
  alias_count: number;
  type_change_count: number;
  changed: Array<{ table: string; rows: Array<{ id: string; content_hash: string }> }>;
  deleted: Array<{ table: string; ids: string[] }>;
  aliases: Array<{ old_id: string; new_id: string }>;
  type_changes: Array<{
    id: string;
    from_table: string;
    from_type: string;
    to_table: string;
    to_type: string;
  }>;
};

export type ChangeFeedResult =
  | { kind: "ok"; feed: VocabularyChangeFeedWire }
  | { kind: "unavailable"; status: 409 | 410; reason: string };

const CHANGE_FEED_MAX_VERSIONS = 256;
const CHANGE_FEED_MAX_MUTATIONS = 5_000;

/// Coalesce immutable per-version records without touching the live vocabulary
/// tables. Work is O(retained changes), independent of catalogue size.
export async function getChangeFeed(
  env: Env,
  fromVersion: string,
  scope: Scope,
  chain: string[],
): Promise<ChangeFeedResult> {
  const language = chain[0] ?? DEFAULT_LANG;
  const target = await getVersionView(env, scope, chain);
  if (!target) {
    return { kind: "unavailable", status: 410, reason: "change history unavailable" };
  }
  const from = await versionViewFor(env, scope, language, fromVersion).catch(() => null);
  if (!from) {
    return { kind: "unavailable", status: 410, reason: "history gap or expired cursor" };
  }
  if (from.datasetGeneration !== target.datasetGeneration) {
    return { kind: "unavailable", status: 409, reason: "incompatible generation" };
  }
  const span = target.sequence - from.sequence;
  if (span <= 0 || span > CHANGE_FEED_MAX_VERSIONS) {
    return { kind: "unavailable", status: 410, reason: "history span unavailable" };
  }

  type ChangeRow = {
    sequence: number;
    table_name: string;
    word_id: string;
    operation: "changed" | "deleted";
    content_hash: string | null;
    previous_content_hash: string | null;
  };
  const changes = await readOnlySelect(env,
    `SELECT sequence, table_name, word_id, operation, content_hash,
            previous_content_hash
       FROM vocabulary_change_rows
      WHERE scope = ? AND language = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence ASC, table_name ASC, word_id ASC
      LIMIT ?`
  ).bind(
    scope, language, from.sequence, target.sequence, CHANGE_FEED_MAX_MUTATIONS + 1
  ).all<ChangeRow>();
  if (changes.results.length > CHANGE_FEED_MAX_MUTATIONS) {
    return { kind: "unavailable", status: 410, reason: "delta is excessive" };
  }

  const initiallyPresent = new Map<string, boolean>();
  const latest = new Map<string, ChangeRow>();
  for (const row of changes.results) {
    if (!initiallyPresent.has(row.word_id)) {
      // Every immutable operation carries the hash immediately before it.
      // null means the word did not exist at the client's starting cursor.
      initiallyPresent.set(row.word_id, row.previous_content_hash !== null);
    }
    latest.set(row.word_id, row);
  }
  if (latest.size > CHANGE_FEED_MAX_MUTATIONS) {
    return { kind: "unavailable", status: 410, reason: "delta is excessive" };
  }
  // A word created and retired entirely inside the missed version span is absent
  // at both ends. Omitting it avoids asking the client to delete a row it never
  // owned. Other cycles (delete→re-add, update→delete) remain real mutations.
  const finalRows = [...latest.values()].filter((row) =>
    initiallyPresent.get(row.word_id) === true || row.operation === "changed"
  );

  const tableOrder = ["verbs", "nouns", "adverbs_adjectives"];
  const changed = tableOrder.map((table) => ({
    table,
    rows: finalRows
      .filter((row) => row.table_name === table && row.operation === "changed")
      .sort((a, b) => a.word_id.localeCompare(b.word_id))
      .map((row) => ({ id: row.word_id, content_hash: String(row.content_hash) })),
  })).filter((group) => group.rows.length > 0);
  const deleted = tableOrder.map((table) => ({
    table,
    ids: finalRows
      .filter((row) => row.table_name === table && row.operation === "deleted")
      .map((row) => row.word_id)
      .sort(),
  })).filter((group) => group.ids.length > 0);

  type AliasRow = { sequence: number; old_id: string; new_id: string };
  const aliasRows = await readOnlySelect(env,
    `SELECT sequence, old_id, new_id
       FROM vocabulary_alias_changes
      WHERE scope = ? AND language = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence ASC, old_id ASC`
  ).bind(scope, language, from.sequence, target.sequence).all<AliasRow>();
  const aliasMap = new Map<string, string>();
  for (const row of aliasRows.results) aliasMap.set(row.old_id, row.new_id);
  const finalDeleted = new Set(
    finalRows
      .filter((row) => row.operation === "deleted")
      .map((row) => row.word_id),
  );
  const aliases = [...aliasMap.entries()]
    .filter(([oldID, newID]) => finalDeleted.has(oldID) && !finalDeleted.has(newID))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([old_id, new_id]) => ({ old_id, new_id }));

  type TypeRow = {
    sequence: number;
    word_id: string;
    from_table: string;
    from_type: string;
    to_table: string;
    to_type: string;
  };
  const typeRows = await readOnlySelect(env,
    `SELECT sequence, word_id, from_table, from_type, to_table, to_type
       FROM vocabulary_type_changes
      WHERE scope = ? AND language = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence ASC, word_id ASC`
  ).bind(scope, language, from.sequence, target.sequence).all<TypeRow>();
  const typeMap = new Map<string, TypeRow>();
  for (const row of typeRows.results) {
    const prior = typeMap.get(row.word_id);
    typeMap.set(row.word_id, prior ? { ...row, from_type: prior.from_type } : row);
  }
  const typeChanges = [...typeMap.values()]
    .filter((row) => row.from_type !== row.to_type
      && initiallyPresent.get(row.word_id) === true
      && latest.get(row.word_id)?.operation === "changed"
      && latest.get(row.word_id)?.table_name === "adverbs_adjectives")
    .sort((a, b) => a.word_id.localeCompare(b.word_id))
    .map((row) => ({
      id: row.word_id,
      from_table: row.from_table,
      from_type: row.from_type,
      to_table: row.to_table,
      to_type: row.to_type,
    }));

  const changedCount = changed.reduce((sum, group) => sum + group.rows.length, 0);
  const deletedCount = deleted.reduce((sum, group) => sum + group.ids.length, 0);
  return {
    kind: "ok",
    feed: {
      contract_version: 1,
      from_version: from.version,
      to_version: target.version,
      from_sequence: from.sequence,
      to_sequence: target.sequence,
      change_set_count: span,
      dataset_generation: target.datasetGeneration,
      language,
      scope,
      from_fingerprint: from.fingerprint,
      target_fingerprint: target.fingerprint,
      from_counts: from.counts,
      target_counts: target.counts,
      changed_count: changedCount,
      deleted_count: deletedCount,
      alias_count: aliases.length,
      type_change_count: typeChanges.length,
      changed,
      deleted,
      aliases,
      type_changes: typeChanges,
    },
  };
}

/// Exact immutable wire rows for ids named by a change feed. The latest snapshot
/// at or before the requested target sequence wins, so a later publication can
/// never replace bytes underneath an in-flight client.
export async function getVersionedRows(
  env: Env,
  table: TableName,
  ids: string[],
  scope: Scope,
  chain: string[],
  version: string,
): Promise<Record<string, unknown>[] | null> {
  const language = chain[0] ?? DEFAULT_LANG;
  const target = await versionViewFor(env, scope, language, version).catch(() => null);
  if (!target) return null;
  const resultByID = new Map<string, Record<string, unknown>>();
  for (let offset = 0; offset < ids.length; offset += ROWS_BIND_CHUNK) {
    const chunk = ids.slice(offset, offset + ROWS_BIND_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    type StoredRow = { word_id: string; content_hash: string; payload_json: string };
    const rows = await readOnlySelect(env,
      `SELECT word_id, content_hash, payload_json FROM (
         SELECT word_id, content_hash, payload_json,
                ROW_NUMBER() OVER (
                  PARTITION BY word_id ORDER BY sequence DESC
                ) AS rank
           FROM vocabulary_version_rows
          WHERE scope = ? AND language = ? AND table_name = ?
            AND sequence <= ? AND word_id IN (${placeholders})
       ) WHERE rank = 1`
    ).bind(
      scope, language, table, target.sequence, ...chunk
    ).all<StoredRow>();
    for (const stored of rows.results) {
      const decoded = JSON.parse(stored.payload_json) as Record<string, unknown>;
      if (decoded.id !== stored.word_id || decoded.content_hash !== stored.content_hash) {
        return null;
      }
      resultByID.set(stored.word_id, decoded);
    }
  }
  if (resultByID.size !== new Set(ids).size) return null;
  return ids.map((id) => resultByID.get(id)!).filter(Boolean);
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
    for (const r of res.results) map[r.id] = await wireContentHash(r.content_hash);
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
    for (const row of res.results as Record<string, unknown>[]) {
      rows.push(await normalizeWireRow(row));
    }
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
    for (const raw of res.results) {
      const row = await normalizeWireRow(raw);
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
// Preferred full-install path. Publication exposes a manifest only after every
// immutable block has been uploaded and verified. A client pins snapshot_id and
// may continue reading that frozen generation after the current pointer moves.
export async function getBlockSnapshotManifest(
  env: Env,
  scope: Scope,
  chain: string[],
  snapshotID?: string,
): Promise<SnapshotManifest | null> {
  const language = chain[0] ?? DEFAULT_LANG;
  const manifest = await readOnlySelect(env, snapshotID
    ? `SELECT m.snapshot_id, m.sequence, m.base_version, m.version, m.dataset_generation,
            m.schema_version, m.scope, m.language, m.fingerprint,
            m.verbs_count, m.nouns_count, m.adverbs_adjectives_count,
            m.block_count, m.total_compressed_bytes, m.total_uncompressed_bytes,
            m.manifest_checksum
       FROM vocabulary_snapshot_manifests m
      WHERE m.snapshot_id = ? AND m.scope = ? AND m.language = ?`
    : `SELECT m.snapshot_id, m.sequence, m.base_version, m.version, m.dataset_generation,
            m.schema_version, m.scope, m.language, m.fingerprint,
            m.verbs_count, m.nouns_count, m.adverbs_adjectives_count,
            m.block_count, m.total_compressed_bytes, m.total_uncompressed_bytes,
            m.manifest_checksum
       FROM vocabulary_snapshot_pointers p
       JOIN vocabulary_snapshot_manifests m ON m.snapshot_id = p.snapshot_id
      WHERE p.scope = ? AND p.language = ?`
  ).bind(...(snapshotID
    ? [snapshotID, scope, language]
    : [scope, language])).first<Record<string, unknown>>();
  if (!manifest) return null;

  const blockResult = await readOnlySelect(env,
    `SELECT block_id, table_name, block_index, row_count, compressed_bytes,
            uncompressed_bytes, checksum
       FROM vocabulary_snapshot_blocks
      WHERE snapshot_id = ? AND committed = 1
      ORDER BY CASE table_name
                 WHEN 'verbs' THEN 0
                 WHEN 'nouns' THEN 1
                 ELSE 2
               END,
               block_index`
  ).bind(String(manifest.snapshot_id)).all<Record<string, unknown>>();
  const blocks = blockResult.results.map((row): SnapshotBlockMetadata => ({
    id: String(row.block_id),
    table: String(row.table_name) as TableName,
    index: Number(row.block_index),
    row_count: Number(row.row_count),
    compressed_bytes: Number(row.compressed_bytes),
    uncompressed_bytes: Number(row.uncompressed_bytes),
    checksum: String(row.checksum),
  }));
  if (blocks.length !== Number(manifest.block_count)) return null;

  const counts = {
    verbs: Number(manifest.verbs_count),
    nouns: Number(manifest.nouns_count),
    adverbs_adjectives: Number(manifest.adverbs_adjectives_count),
  };
  return {
    contract_version: 1,
    snapshot_id: String(manifest.snapshot_id),
    sequence: Number(manifest.sequence),
    dataset_generation: Number(manifest.dataset_generation),
    base_version: String(manifest.base_version),
    version: String(manifest.version),
    language: String(manifest.language),
    scope: String(manifest.scope) as Scope,
    schema_version: Number(manifest.schema_version),
    compression: "zlib",
    total_count: counts.verbs + counts.nouns + counts.adverbs_adjectives,
    table_counts: counts,
    global_fingerprint: String(manifest.fingerprint),
    block_count: Number(manifest.block_count),
    total_compressed_bytes: Number(manifest.total_compressed_bytes),
    total_uncompressed_bytes: Number(manifest.total_uncompressed_bytes),
    blocks,
    manifest_checksum: String(manifest.manifest_checksum),
  };
}

function blockBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)
      && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return new Uint8Array(value);
  }
  return null;
}

export async function getBlockSnapshotPayload(
  env: Env,
  snapshotID: string,
  blockID: string,
  scope: Scope,
  chain: string[],
): Promise<SnapshotBlockPayload | null> {
  const language = chain[0] ?? DEFAULT_LANG;
  const row = await readOnlySelect(env,
    `SELECT b.block_id, b.table_name, b.block_index, b.row_count,
            b.compressed_bytes, b.uncompressed_bytes, b.checksum, b.payload
       FROM vocabulary_snapshot_blocks b
       JOIN vocabulary_snapshot_manifests m ON m.snapshot_id = b.snapshot_id
      WHERE b.snapshot_id = ? AND b.block_id = ? AND b.committed = 1
        AND m.scope = ? AND m.language = ?`
  ).bind(snapshotID, blockID, scope, language).first<Record<string, unknown>>();
  if (!row) return null;
  const payload = blockBytes(row.payload);
  if (!payload || payload.byteLength !== Number(row.compressed_bytes)) return null;
  return {
    metadata: {
      id: String(row.block_id),
      table: String(row.table_name) as TableName,
      index: Number(row.block_index),
      row_count: Number(row.row_count),
      compressed_bytes: Number(row.compressed_bytes),
      uncompressed_bytes: Number(row.uncompressed_bytes),
      checksum: String(row.checksum),
    },
    payload,
  };
}

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
    for (const raw of res.results as Record<string, unknown>[]) {
      lines.push(JSON.stringify({ t, row: await normalizeWireRow(raw) }));
    }
  }
  return lines.join("\n") + "\n";
}
