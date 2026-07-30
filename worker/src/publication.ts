import {
  PHYSICAL_TABLES,
  TABLE_COLUMNS,
  PhysicalTable,
  isPhysicalTable,
} from "./content-tables";
import {
  SnapshotManifest,
  SnapshotValidationError,
  SnapshotViewMetadata,
  snapshotActivationStatements,
  validateSnapshotManifests,
} from "./snapshot-publication";

interface PublicationEnv {
  CONTENT_DB: D1Database;
}

const CONTRACT_VERSION = 1;
const RETAINED_VERSION_COUNT = 256;
// One immutable server publication is intentionally smaller than the client's
// 5,000-mutation coalesced ceiling. A client may safely combine several retained
// versions, while each D1 transaction/request remains comfortably bounded.
const MAX_PHYSICAL_MUTATIONS = 500;
const MAX_VIEW_MUTATIONS = 500;
const EXPECTED_LANGUAGES = ["en", "en-US", "es-419", "es-MX", "es-ES", "zh"];
const EXPECTED_SCOPES = ["free", "full"];
const CANONICAL_TABLES = new Set(["verbs", "nouns", "adverbs_adjectives"]);
const SAFE_ID = /^[A-Za-z0-9._-]{1,256}$/;
const TRANSLATION_ID = /^[A-Za-z0-9._-]{1,256}:[A-Za-z0-9-]{1,32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^xor256-v1:[0-9a-f]{64}$/;

type Counts = {
  verbs: number;
  nouns: number;
  adverbs_adjectives: number;
};

type CurrentCursor = {
  sequence: number;
  base_version: string;
  dataset_generation: number;
};

type PhysicalMutation = {
  table: string;
  upsert: Array<Record<string, unknown>>;
  delete: string[];
};

type ChangedRow = {
  table: string;
  id: string;
  content_hash: string;
  previous_content_hash: string | null;
  row: Record<string, unknown>;
};

type DeletedRow = {
  table: string;
  id: string;
  content_hash: string;
};

type AliasChange = {
  old_id: string;
  new_id: string;
};

type TypeChange = {
  id: string;
  from_table: string;
  from_type: string;
  to_table: string;
  to_type: string;
};

type PublicationView = {
  scope: string;
  language: string;
  from_fingerprint: string;
  target_fingerprint: string;
  from_counts: Counts;
  target_counts: Counts;
  changed: ChangedRow[];
  deleted: DeletedRow[];
  aliases: AliasChange[];
  type_changes: TypeChange[];
};

type CommitBody = {
  contract_version: number;
  from_base_version: string | null;
  target_base_version: string;
  dataset_generation: number;
  physical: PhysicalMutation[];
  views: PublicationView[];
  snapshots?: SnapshotManifest[];
};

type BaselineView = {
  scope: string;
  language: string;
  target_fingerprint: string;
  target_counts: Counts;
};

type BaselineBody = {
  contract_version: number;
  target_base_version: string;
  dataset_generation: number;
  views: BaselineView[];
  snapshots?: SnapshotManifest[];
};

class PublicationValidationError extends Error {}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSafeID(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value.startsWith("custom-")) {
    throw new PublicationValidationError(`${label}: invalid id`);
  }
}

function requireHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new PublicationValidationError(`${label}: invalid sha256`);
  }
}

function requirePhysicalID(
  value: unknown,
  table: PhysicalTable,
): asserts value is string {
  const pattern = table === "translations" ? TRANSLATION_ID : SAFE_ID;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new PublicationValidationError(`${table}: invalid physical id`);
  }
}

function requireFingerprint(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !FINGERPRINT.test(value)) {
    throw new PublicationValidationError(`${label}: invalid fingerprint`);
  }
}

function requireCounts(value: unknown, label: string): asserts value is Counts {
  if (!isObject(value)) {
    throw new PublicationValidationError(`${label}: invalid counts`);
  }
  for (const key of ["verbs", "nouns", "adverbs_adjectives"]) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 1_000_000) {
      throw new PublicationValidationError(`${label}.${key}: invalid count`);
    }
  }
}

function countTotal(counts: Counts): number {
  return counts.verbs + counts.nouns + counts.adverbs_adjectives;
}

function viewKey(scope: string, language: string): string {
  return `${scope}\0${language}`;
}

function validateViewSet<T extends { scope: string; language: string }>(
  views: T[],
): Map<string, T> {
  if (!Array.isArray(views)) {
    throw new PublicationValidationError("views must be an array");
  }
  const result = new Map<string, T>();
  for (const view of views) {
    if (!EXPECTED_SCOPES.includes(view.scope) || !EXPECTED_LANGUAGES.includes(view.language)) {
      throw new PublicationValidationError("unknown scope/language view");
    }
    const key = viewKey(view.scope, view.language);
    if (result.has(key)) {
      throw new PublicationValidationError("duplicate scope/language view");
    }
    result.set(key, view);
  }
  const expected = EXPECTED_LANGUAGES.length * EXPECTED_SCOPES.length;
  if (result.size !== expected) {
    throw new PublicationValidationError(`expected ${expected} complete views`);
  }
  return result;
}

function validatePhysical(physical: PhysicalMutation[]): number {
  if (!Array.isArray(physical)) {
    throw new PublicationValidationError("physical must be an array");
  }
  const seenTables = new Set<string>();
  let mutations = 0;
  for (const group of physical) {
    if (!isPhysicalTable(group.table) || seenTables.has(group.table)) {
      throw new PublicationValidationError("unknown or duplicate physical table");
    }
    seenTables.add(group.table);
    if (!Array.isArray(group.upsert) || !Array.isArray(group.delete)) {
      throw new PublicationValidationError(`${group.table}: invalid mutation arrays`);
    }
    const ids = new Set<string>();
    for (const row of group.upsert) {
      if (!isObject(row)) {
        throw new PublicationValidationError(`${group.table}: invalid row`);
      }
      requirePhysicalID(row.id, group.table);
      requireHash(row.content_hash, String(row.id));
      if (group.table === "verbs" && row.type !== "verb") {
        throw new PublicationValidationError(`${row.id}: invalid verb type`);
      }
      if (group.table === "nouns" && row.type !== "noun") {
        throw new PublicationValidationError(`${row.id}: invalid noun type`);
      }
      if (group.table === "adverbs_adjectives"
          && !["adverb", "adjective"].includes(String(row.type))) {
        throw new PublicationValidationError(`${row.id}: invalid adjective/adverb type`);
      }
      if (group.table === "translations") {
        requireSafeID(row.word_id, `${row.id} word_id`);
        if (typeof row.lang !== "string"
            || !EXPECTED_LANGUAGES.includes(row.lang)
            || row.id !== `${row.word_id}:${row.lang}`) {
          throw new PublicationValidationError(`${row.id}: invalid translation identity`);
        }
      }
      if (group.table === "id_aliases") {
        requireSafeID(row.new_id, `${row.id} new_id`);
        if (row.id === row.new_id || typeof row.reason !== "string") {
          throw new PublicationValidationError(`${row.id}: invalid alias row`);
        }
      }
      if (ids.has(row.id)) {
        throw new PublicationValidationError(`${group.table}: duplicate id ${row.id}`);
      }
      ids.add(row.id);
    }
    for (const id of group.delete) {
      requirePhysicalID(id, group.table);
      if (ids.has(id)) {
        throw new PublicationValidationError(`${group.table}: conflicting id ${id}`);
      }
      ids.add(id);
    }
    mutations += group.upsert.length + group.delete.length;
  }
  if (seenTables.size !== PHYSICAL_TABLES.length) {
    throw new PublicationValidationError("physical mutation set is incomplete");
  }
  if (mutations <= 0 || mutations > MAX_PHYSICAL_MUTATIONS) {
    throw new PublicationValidationError("physical mutation count is not routine-sized");
  }
  return mutations;
}

async function validateAliasTarget(
  env: PublicationEnv,
  physical: PhysicalMutation[],
): Promise<void> {
  const rows = await env.CONTENT_DB.prepare(
    "SELECT id, new_id FROM id_aliases",
  ).all<{ id: string; new_id: string }>();
  const aliases = new Map(rows.results.map((row) => [row.id, row.new_id]));
  const group = physical.find((item) => item.table === "id_aliases")!;
  for (const id of group.delete) aliases.delete(id);
  for (const row of group.upsert) aliases.set(String(row.id), String(row.new_id));
  for (const source of aliases.keys()) {
    const visited = new Set<string>();
    let current = source;
    let completed = false;
    for (let depth = 0; depth < 4; depth++) {
      if (visited.has(current)) {
        throw new PublicationValidationError(`alias cycle at ${source}`);
      }
      visited.add(current);
      const next = aliases.get(current);
      if (!next) {
        completed = true;
        break;
      }
      current = next;
    }
    if (!completed && aliases.has(current)) {
      throw new PublicationValidationError(`alias chain exceeds four hops at ${source}`);
    }
  }
}

function countKey(table: string): keyof Counts {
  if (table === "verbs") return "verbs";
  if (table === "nouns") return "nouns";
  return "adverbs_adjectives";
}

function fingerprintBytes(value: string): Uint8Array {
  const hex = value.slice("xor256-v1:".length);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function toggleFingerprint(
  accumulator: Uint8Array,
  table: string,
  id: string,
  contentHash: string,
): Promise<void> {
  const contribution = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${table}\0${id}\0${contentHash}`),
  ));
  for (let index = 0; index < accumulator.length; index++) {
    accumulator[index] ^= contribution[index];
  }
}

function encodedFingerprint(bytes: Uint8Array): string {
  return "xor256-v1:" + [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function validatePublicationView(view: PublicationView): Promise<void> {
  requireFingerprint(view.from_fingerprint, "from_fingerprint");
  requireFingerprint(view.target_fingerprint, "target_fingerprint");
  requireCounts(view.from_counts, "from_counts");
  requireCounts(view.target_counts, "target_counts");
  if (!Array.isArray(view.changed) || !Array.isArray(view.deleted)
      || !Array.isArray(view.aliases) || !Array.isArray(view.type_changes)) {
    throw new PublicationValidationError("invalid view change arrays");
  }
  const changed = new Map<string, string>();
  const deleted = new Set<string>();
  for (const entry of view.changed) {
    if (!CANONICAL_TABLES.has(entry.table) || !isObject(entry.row)) {
      throw new PublicationValidationError("invalid changed row");
    }
    requireSafeID(entry.id, "changed");
    requireHash(entry.content_hash, entry.id);
    if (entry.previous_content_hash !== null) {
      requireHash(entry.previous_content_hash, `${entry.id} previous`);
    }
    if (entry.row.id !== entry.id || entry.row.content_hash !== entry.content_hash) {
      throw new PublicationValidationError(`${entry.id}: row identity/hash mismatch`);
    }
    const type = entry.row.type;
    if ((entry.table === "verbs" && type !== "verb")
        || (entry.table === "nouns" && type !== "noun")
        || (entry.table === "adverbs_adjectives"
          && !["adjective", "adverb"].includes(String(type)))) {
      throw new PublicationValidationError(`${entry.id}: row table/type mismatch`);
    }
    if (changed.has(entry.id)) {
      throw new PublicationValidationError(`${entry.id}: duplicate changed id`);
    }
    changed.set(entry.id, entry.table);
  }
  for (const entry of view.deleted) {
    if (!CANONICAL_TABLES.has(entry.table)) {
      throw new PublicationValidationError("invalid deleted table");
    }
    requireSafeID(entry.id, "deleted");
    requireHash(entry.content_hash, `${entry.id} deleted`);
    if (deleted.has(entry.id) || changed.has(entry.id)) {
      throw new PublicationValidationError(`${entry.id}: conflicting deleted id`);
    }
    deleted.add(entry.id);
  }
  const mutationCount = changed.size + deleted.size;
  if (mutationCount > MAX_VIEW_MUTATIONS) {
    throw new PublicationValidationError("view delta is excessive");
  }
  if (Math.abs(countTotal(view.target_counts) - countTotal(view.from_counts))
      > mutationCount) {
    throw new PublicationValidationError("view count delta exceeds mutations");
  }

  // Independently project target counts and the order-independent fingerprint
  // from the immutable source metadata. This validates the publisher's target
  // descriptor without scanning the catalogue.
  const projectedCounts: Counts = { ...view.from_counts };
  const projectedFingerprint = fingerprintBytes(view.from_fingerprint);
  for (const entry of view.changed) {
    const key = countKey(entry.table);
    if (entry.previous_content_hash === null) {
      projectedCounts[key] += 1;
    } else {
      await toggleFingerprint(
        projectedFingerprint, entry.table, entry.id, entry.previous_content_hash,
      );
    }
    await toggleFingerprint(
      projectedFingerprint, entry.table, entry.id, entry.content_hash,
    );
  }
  for (const entry of view.deleted) {
    const key = countKey(entry.table);
    projectedCounts[key] -= 1;
    if (projectedCounts[key] < 0) {
      throw new PublicationValidationError("projected count became negative");
    }
    await toggleFingerprint(
      projectedFingerprint, entry.table, entry.id, entry.content_hash,
    );
  }
  if (projectedCounts.verbs !== view.target_counts.verbs
      || projectedCounts.nouns !== view.target_counts.nouns
      || projectedCounts.adverbs_adjectives !== view.target_counts.adverbs_adjectives
      || encodedFingerprint(projectedFingerprint) !== view.target_fingerprint) {
    throw new PublicationValidationError("target counts/fingerprint projection mismatch");
  }
  const aliasSources = new Set<string>();
  for (const alias of view.aliases) {
    requireSafeID(alias.old_id, "alias old");
    requireSafeID(alias.new_id, "alias new");
    if (alias.old_id === alias.new_id || !deleted.has(alias.old_id)
        || deleted.has(alias.new_id) || aliasSources.has(alias.old_id)) {
      throw new PublicationValidationError("invalid alias");
    }
    aliasSources.add(alias.old_id);
  }
  const typed = new Set<string>();
  for (const change of view.type_changes) {
    requireSafeID(change.id, "type change");
    if (change.from_table !== "adverbs_adjectives"
        || change.to_table !== "adverbs_adjectives"
        || !["adjective", "adverb"].includes(change.from_type)
        || !["adjective", "adverb"].includes(change.to_type)
        || change.from_type === change.to_type
        || changed.get(change.id) !== "adverbs_adjectives"
        || typed.has(change.id)) {
      throw new PublicationValidationError("invalid type change");
    }
    typed.add(change.id);
  }
}

async function currentCursor(env: PublicationEnv): Promise<CurrentCursor | null> {
  return env.CONTENT_DB.prepare(
    `SELECT sequence, base_version, dataset_generation
       FROM vocabulary_versions
      ORDER BY sequence DESC LIMIT 1`,
  ).first<CurrentCursor>();
}

async function currentViewMap(
  env: PublicationEnv,
  sequence: number,
): Promise<Map<string, Record<string, unknown>>> {
  const rows = await env.CONTENT_DB.prepare(
    `SELECT scope, language, fingerprint, verbs_count, nouns_count,
            adverbs_adjectives_count
       FROM vocabulary_version_views WHERE sequence = ?`,
  ).bind(sequence).all<Record<string, unknown>>();
  return new Map(rows.results.map((row) => [
    viewKey(String(row.scope), String(row.language)),
    row,
  ]));
}

function countsMatch(counts: Counts, row: Record<string, unknown>): boolean {
  return counts.verbs === Number(row.verbs_count)
    && counts.nouns === Number(row.nouns_count)
    && counts.adverbs_adjectives === Number(row.adverbs_adjectives_count);
}

function physicalStatements(
  env: PublicationEnv,
  physical: PhysicalMutation[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const group of physical) {
    const table = group.table as PhysicalTable;
    const columns = TABLE_COLUMNS[table];
    if (group.upsert.length > 0) {
      const select = columns
        .map((column) => `json_extract(value, '$.${column}')`)
        .join(", ");
      const update = columns
        .filter((column) => column !== "id")
        .map((column) => `${column} = excluded.${column}`)
        .join(", ");
      statements.push(env.CONTENT_DB.prepare(
        `INSERT INTO ${table} (${columns.join(", ")})
         SELECT ${select} FROM json_each(?) WHERE 1
         ON CONFLICT(id) DO UPDATE SET ${update}, updated_at = datetime('now')`,
      ).bind(JSON.stringify(group.upsert)));
    }
    if (group.delete.length > 0) {
      statements.push(env.CONTENT_DB.prepare(
        `DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`,
      ).bind(JSON.stringify(group.delete)));
    }
  }
  return statements;
}

function metadataStatements(
  env: PublicationEnv,
  sequence: number,
  baseVersion: string,
  generation: number,
  views: Array<PublicationView | BaselineView>,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    env.CONTENT_DB.prepare(
      `INSERT INTO vocabulary_versions
         (sequence, base_version, dataset_generation) VALUES (?, ?, ?)`,
    ).bind(sequence, baseVersion, generation),
  ];
  for (const view of views) {
    statements.push(env.CONTENT_DB.prepare(
      `INSERT INTO vocabulary_version_views
         (sequence, scope, language, version, fingerprint,
          verbs_count, nouns_count, adverbs_adjectives_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      sequence,
      view.scope,
      view.language,
      `${baseVersion}:${view.scope}`,
      view.target_fingerprint,
      view.target_counts.verbs,
      view.target_counts.nouns,
      view.target_counts.adverbs_adjectives,
    ));
  }
  statements.push(
    env.CONTENT_DB.prepare(
      `INSERT INTO meta(key, value) VALUES ('dataset_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(baseVersion),
    env.CONTENT_DB.prepare(
      `INSERT INTO meta(key, value) VALUES ('dataset_sequence', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(String(sequence)),
    env.CONTENT_DB.prepare(
      `INSERT INTO meta(key, value) VALUES ('dataset_generation', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(String(generation)),
  );
  return statements;
}

function historyStatements(
  env: PublicationEnv,
  sequence: number,
  views: PublicationView[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const view of views) {
    const operations = [
      ...view.changed.map((entry) => ({
        table: entry.table,
        id: entry.id,
        operation: "changed",
        content_hash: entry.content_hash,
        previous_content_hash: entry.previous_content_hash,
      })),
      ...view.deleted.map((entry) => ({
        table: entry.table,
        id: entry.id,
        operation: "deleted",
        content_hash: null,
        previous_content_hash: entry.content_hash,
      })),
    ];
    if (operations.length > 0) {
      statements.push(env.CONTENT_DB.prepare(
        `INSERT INTO vocabulary_change_rows
           (sequence, scope, language, table_name, word_id, operation,
            content_hash, previous_content_hash)
         SELECT ?, ?, ?,
                json_extract(value, '$.table'),
                json_extract(value, '$.id'),
                json_extract(value, '$.operation'),
                json_extract(value, '$.content_hash'),
                json_extract(value, '$.previous_content_hash')
           FROM json_each(?)`,
      ).bind(sequence, view.scope, view.language, JSON.stringify(operations)));
    }
    if (view.changed.length > 0) {
      statements.push(env.CONTENT_DB.prepare(
        `INSERT INTO vocabulary_version_rows
           (sequence, scope, language, table_name, word_id, content_hash, payload_json)
         SELECT ?, ?, ?,
                json_extract(value, '$.table'),
                json_extract(value, '$.id'),
                json_extract(value, '$.content_hash'),
                json_extract(value, '$.row')
           FROM json_each(?)`,
      ).bind(sequence, view.scope, view.language, JSON.stringify(view.changed)));
    }
    if (view.aliases.length > 0) {
      statements.push(env.CONTENT_DB.prepare(
        `INSERT INTO vocabulary_alias_changes
           (sequence, scope, language, old_id, new_id)
         SELECT ?, ?, ?,
                json_extract(value, '$.old_id'),
                json_extract(value, '$.new_id')
           FROM json_each(?)`,
      ).bind(sequence, view.scope, view.language, JSON.stringify(view.aliases)));
    }
    if (view.type_changes.length > 0) {
      statements.push(env.CONTENT_DB.prepare(
        `INSERT INTO vocabulary_type_changes
           (sequence, scope, language, word_id,
            from_table, from_type, to_table, to_type)
         SELECT ?, ?, ?,
                json_extract(value, '$.id'),
                json_extract(value, '$.from_table'),
                json_extract(value, '$.from_type'),
                json_extract(value, '$.to_table'),
                json_extract(value, '$.to_type')
           FROM json_each(?)`,
      ).bind(sequence, view.scope, view.language, JSON.stringify(view.type_changes)));
    }
  }
  return statements;
}

function retentionStatements(
  env: PublicationEnv,
  sequence: number,
): D1PreparedStatement[] {
  const cutoff = sequence - RETAINED_VERSION_COUNT;
  if (cutoff <= 0) return [];
  return [
    // Snapshot pointers are moved before retention in the same transaction.
    // Remove blocks and manifests for superseded, now-unpointed snapshots before
    // deleting their vocabulary_versions parent. The current frozen snapshot is
    // protected by the NOT EXISTS pointer predicate and can never be pruned.
    env.CONTENT_DB.prepare(
      `DELETE FROM vocabulary_snapshot_blocks
         WHERE snapshot_id IN (
           SELECT m.snapshot_id
             FROM vocabulary_snapshot_manifests AS m
            WHERE m.sequence <= ?
              AND NOT EXISTS (
                SELECT 1 FROM vocabulary_snapshot_pointers AS p
                 WHERE p.snapshot_id = m.snapshot_id
              )
         )`,
    ).bind(cutoff),
    env.CONTENT_DB.prepare(
      `DELETE FROM vocabulary_snapshot_manifests
         WHERE sequence <= ?
           AND NOT EXISTS (
             SELECT 1 FROM vocabulary_snapshot_pointers AS p
              WHERE p.snapshot_id =
                    vocabulary_snapshot_manifests.snapshot_id
           )`,
    ).bind(cutoff),
  ].concat([
    "vocabulary_change_rows",
    "vocabulary_version_rows",
    "vocabulary_alias_changes",
    "vocabulary_type_changes",
    "vocabulary_version_views",
  ].map((table) => env.CONTENT_DB.prepare(
    `DELETE FROM ${table} WHERE sequence <= ?`,
  ).bind(cutoff)).concat([
    env.CONTENT_DB.prepare(
      "DELETE FROM vocabulary_versions WHERE sequence <= ?",
    ).bind(cutoff),
  ]));
}

export async function handlePublicationState(
  env: PublicationEnv,
): Promise<Response> {
  try {
    const tables: Record<string, unknown[]> = {};
    for (const table of PHYSICAL_TABLES) {
      const columns = TABLE_COLUMNS[table].join(", ");
      const result = await env.CONTENT_DB.prepare(
        `SELECT ${columns} FROM ${table} ORDER BY id`,
      ).all();
      tables[table] = result.results;
    }
    let cursor: CurrentCursor | null = null;
    let historyAvailable = true;
    let snapshotPointerCount = 0;
    let oldestSnapshotSequence: number | null = null;
    try {
      cursor = await currentCursor(env);
    } catch {
      historyAvailable = false;
    }
    try {
      const snapshotState = await env.CONTENT_DB.prepare(
        `SELECT COUNT(*) AS count, MIN(m.sequence) AS oldest_sequence
           FROM vocabulary_snapshot_pointers AS p
           JOIN vocabulary_snapshot_manifests AS m
             ON m.snapshot_id = p.snapshot_id`,
      ).first<{ count: number; oldest_sequence: number | null }>();
      snapshotPointerCount = Number(snapshotState?.count ?? 0);
      const oldest = snapshotState?.oldest_sequence;
      oldestSnapshotSequence = oldest === null || oldest === undefined
        ? null
        : Number(oldest);
    } catch {
      snapshotPointerCount = 0;
      oldestSnapshotSequence = null;
    }
    return response({
      history_available: historyAvailable,
      snapshot_views_available: snapshotPointerCount,
      oldest_snapshot_sequence: oldestSnapshotSequence,
      cursor,
      tables,
    });
  } catch (error) {
    console.error("publication state failed", { error: String(error) });
    return response({ error: "database error" }, 500);
  }
}

export async function handlePublicationAudit(
  env: PublicationEnv,
): Promise<Response> {
  try {
    type AuditView = {
      sequence: number;
      dataset_generation: number;
      scope: string;
      language: string;
      fingerprint: string;
      verbs_count: number;
      nouns_count: number;
      adverbs_adjectives_count: number;
    };
    type AuditChange = {
      sequence: number;
      scope: string;
      language: string;
      table_name: string;
      word_id: string;
      operation: "changed" | "deleted";
      content_hash: string | null;
      previous_content_hash: string | null;
    };
    type AuditStoredRow = {
      sequence: number;
      scope: string;
      language: string;
      table_name: string;
      word_id: string;
      content_hash: string;
      payload_json: string;
    };
    const views = await env.CONTENT_DB.prepare(
      `SELECT vv.sequence, v.dataset_generation, vv.scope, vv.language,
              vv.fingerprint, vv.verbs_count, vv.nouns_count,
              vv.adverbs_adjectives_count
         FROM vocabulary_version_views vv
         JOIN vocabulary_versions v ON v.sequence = vv.sequence
        ORDER BY vv.scope, vv.language, vv.sequence`,
    ).all<AuditView>();
    const changes = await env.CONTENT_DB.prepare(
      `SELECT sequence, scope, language, table_name, word_id, operation,
              content_hash, previous_content_hash
         FROM vocabulary_change_rows
        ORDER BY sequence, scope, language, table_name, word_id`,
    ).all<AuditChange>();
    const storedRows = await env.CONTENT_DB.prepare(
      `SELECT sequence, scope, language, table_name, word_id,
              content_hash, payload_json
         FROM vocabulary_version_rows`,
    ).all<AuditStoredRow>();

    const changesByView = new Map<string, AuditChange[]>();
    for (const change of changes.results) {
      const key = `${change.sequence}\0${viewKey(change.scope, change.language)}`;
      const group = changesByView.get(key) ?? [];
      group.push(change);
      changesByView.set(key, group);
    }
    const storedByIdentity = new Map<string, AuditStoredRow>();
    for (const row of storedRows.results) {
      const key = `${row.sequence}\0${viewKey(row.scope, row.language)}\0`
        + `${row.table_name}\0${row.word_id}`;
      storedByIdentity.set(key, row);
    }

    const groups = new Map<string, AuditView[]>();
    for (const view of views.results) {
      const key = `${view.dataset_generation}\0${viewKey(view.scope, view.language)}`;
      const group = groups.get(key) ?? [];
      group.push(view);
      groups.set(key, group);
    }
    let transitions = 0;
    for (const group of groups.values()) {
      group.sort((a, b) => a.sequence - b.sequence);
      for (let index = 1; index < group.length; index++) {
        const prior = group[index - 1];
        const target = group[index];
        if (target.sequence !== prior.sequence + 1) {
          throw new Error(`retained history gap before sequence ${target.sequence}`);
        }
        const counts: Counts = {
          verbs: Number(prior.verbs_count),
          nouns: Number(prior.nouns_count),
          adverbs_adjectives: Number(prior.adverbs_adjectives_count),
        };
        const fingerprint = fingerprintBytes(prior.fingerprint);
        const key = `${target.sequence}\0${viewKey(target.scope, target.language)}`;
        for (const change of changesByView.get(key) ?? []) {
          const count = countKey(change.table_name);
          if (change.operation === "changed") {
            if (!change.content_hash) throw new Error("changed row lacks target hash");
            if (change.previous_content_hash) {
              await toggleFingerprint(
                fingerprint, change.table_name, change.word_id,
                change.previous_content_hash,
              );
            } else {
              counts[count] += 1;
            }
            await toggleFingerprint(
              fingerprint, change.table_name, change.word_id, change.content_hash,
            );
            const storedKey = `${target.sequence}\0`
              + `${viewKey(target.scope, target.language)}\0`
              + `${change.table_name}\0${change.word_id}`;
            const stored = storedByIdentity.get(storedKey);
            const payload = stored
              ? JSON.parse(stored.payload_json) as Record<string, unknown>
              : null;
            if (!stored || stored.content_hash !== change.content_hash
                || payload?.id !== change.word_id
                || payload?.content_hash !== change.content_hash) {
              throw new Error(`missing/corrupt target row ${change.word_id}`);
            }
          } else {
            if (!change.previous_content_hash) {
              throw new Error("deleted row lacks previous hash");
            }
            counts[count] -= 1;
            await toggleFingerprint(
              fingerprint, change.table_name, change.word_id,
              change.previous_content_hash,
            );
          }
        }
        if (counts.verbs !== Number(target.verbs_count)
            || counts.nouns !== Number(target.nouns_count)
            || counts.adverbs_adjectives !== Number(target.adverbs_adjectives_count)
            || encodedFingerprint(fingerprint) !== target.fingerprint) {
          throw new Error(`transition ${target.sequence} metadata mismatch`);
        }
        transitions++;
      }
    }
    return response({
      status: "ok",
      retained_versions: new Set(views.results.map((view) => view.sequence)).size,
      transitions,
    });
  } catch (error) {
    console.error("publication audit failed", { error: String(error) });
    return response({ status: "failed", error: "publication audit failed" }, 500);
  }
}

export async function handlePublicationCommit(
  env: PublicationEnv,
  request: Request,
): Promise<Response> {
  try {
    const value: unknown = await request.json();
    if (!isObject(value)) {
      throw new PublicationValidationError("body must be an object");
    }
    const body = value as unknown as CommitBody;
    if (body.contract_version !== CONTRACT_VERSION
        || !SHA256.test(body.target_base_version)
        || !Number.isSafeInteger(body.dataset_generation)
        || body.dataset_generation <= 0) {
      throw new PublicationValidationError("invalid publication identity");
    }
    validatePhysical(body.physical);
    await validateAliasTarget(env, body.physical);
    const viewMap = validateViewSet(body.views);
    for (const view of viewMap.values()) await validatePublicationView(view);
    const snapshots = body.snapshots === undefined
      ? []
      : await validateSnapshotManifests(
        env,
        body.snapshots,
        {
          baseVersion: body.target_base_version,
          generation: body.dataset_generation,
          views: body.views as SnapshotViewMetadata[],
        },
      );

    const current = await currentCursor(env);
    if (current) {
      if (body.from_base_version !== current.base_version
          || body.dataset_generation !== current.dataset_generation
          || body.target_base_version === current.base_version) {
        return response({ error: "stale or incompatible publication" }, 409);
      }
      const currentViews = await currentViewMap(env, current.sequence);
      for (const [key, view] of viewMap) {
        const prior = currentViews.get(key);
        if (!prior
            || prior.fingerprint !== view.from_fingerprint
            || !countsMatch(view.from_counts, prior)) {
          return response({ error: "publication source view mismatch" }, 409);
        }
      }
    } else if (body.from_base_version !== null) {
      return response({ error: "publication expected a missing baseline" }, 409);
    }

    const sequence = (current?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new PublicationValidationError("sequence overflow");
    }
    const statements = [
      ...physicalStatements(env, body.physical),
      ...metadataStatements(
        env, sequence, body.target_base_version, body.dataset_generation, body.views,
      ),
      ...historyStatements(env, sequence, body.views),
      ...snapshotActivationStatements(env, snapshots, sequence),
      ...retentionStatements(env, sequence),
    ];
    await env.CONTENT_DB.batch(statements);
    return response({
      sequence,
      base_version: body.target_base_version,
      physical_mutations: body.physical.reduce(
        (sum, group) => sum + group.upsert.length + group.delete.length, 0,
      ),
      snapshots_activated: snapshots.length,
    });
  } catch (error) {
    if (error instanceof PublicationValidationError
        || error instanceof SnapshotValidationError) {
      return response({ error: error.message }, 400);
    }
    console.error("publication commit failed", { error: String(error) });
    return response({ error: "database error" }, 500);
  }
}

export async function handlePublicationBaseline(
  env: PublicationEnv,
  request: Request,
): Promise<Response> {
  try {
    const value: unknown = await request.json();
    if (!isObject(value)) {
      throw new PublicationValidationError("body must be an object");
    }
    const body = value as unknown as BaselineBody;
    if (body.contract_version !== CONTRACT_VERSION
        || !SHA256.test(body.target_base_version)
        || !Number.isSafeInteger(body.dataset_generation)
        || body.dataset_generation <= 0) {
      throw new PublicationValidationError("invalid baseline identity");
    }
    const viewMap = validateViewSet(body.views);
    for (const view of viewMap.values()) {
      requireFingerprint(view.target_fingerprint, "target_fingerprint");
      requireCounts(view.target_counts, "target_counts");
    }
    const snapshots = body.snapshots === undefined
      ? []
      : await validateSnapshotManifests(
        env,
        body.snapshots,
        {
          baseVersion: body.target_base_version,
          generation: body.dataset_generation,
          views: body.views as SnapshotViewMetadata[],
        },
      );
    const current = await currentCursor(env);
    if (current && body.dataset_generation <= current.dataset_generation) {
      return response({ error: "baseline must advance dataset generation" }, 409);
    }
    const sequence = (current?.sequence ?? 0) + 1;
    await env.CONTENT_DB.batch([
      ...metadataStatements(
        env, sequence, body.target_base_version, body.dataset_generation, body.views,
      ),
      ...snapshotActivationStatements(env, snapshots, sequence),
      ...retentionStatements(env, sequence),
    ]);
    return response({
      sequence,
      base_version: body.target_base_version,
      dataset_generation: body.dataset_generation,
      snapshots_activated: snapshots.length,
    });
  } catch (error) {
    if (error instanceof PublicationValidationError
        || error instanceof SnapshotValidationError) {
      return response({ error: error.message }, 400);
    }
    console.error("publication baseline failed", { error: String(error) });
    return response({ error: "database error" }, 500);
  }
}

/// Bootstrap or refresh the immutable block representation for the already
/// published current version without mutating words or advancing the change-feed
/// cursor. Blocks are invisible until this one D1 transaction installs all
/// manifests and pointers.
export async function handleSnapshotActivation(
  env: PublicationEnv,
  request: Request,
): Promise<Response> {
  try {
    const value: unknown = await request.json();
    if (!isObject(value)
        || value.contract_version !== CONTRACT_VERSION
        || typeof value.target_base_version !== "string"
        || !SHA256.test(value.target_base_version)
        || !Number.isSafeInteger(value.dataset_generation)
        || Number(value.dataset_generation) <= 0) {
      throw new PublicationValidationError("invalid snapshot activation identity");
    }
    const current = await currentCursor(env);
    if (!current
        || current.base_version !== value.target_base_version
        || current.dataset_generation !== Number(value.dataset_generation)) {
      return response({ error: "snapshot activation target is no longer current" }, 409);
    }
    const currentViews = await currentViewMap(env, current.sequence);
    const views: SnapshotViewMetadata[] = [...currentViews.values()].map((row) => ({
      scope: String(row.scope),
      language: String(row.language),
      target_fingerprint: String(row.fingerprint),
      target_counts: {
        verbs: Number(row.verbs_count),
        nouns: Number(row.nouns_count),
        adverbs_adjectives: Number(row.adverbs_adjectives_count),
      },
    }));
    const snapshots = await validateSnapshotManifests(
      env,
      value.snapshots,
      {
        baseVersion: current.base_version,
        generation: current.dataset_generation,
        views,
      },
    );
    await env.CONTENT_DB.batch(
      snapshotActivationStatements(env, snapshots, current.sequence),
    );
    return response({
      sequence: current.sequence,
      base_version: current.base_version,
      snapshots_activated: snapshots.length,
    });
  } catch (error) {
    if (error instanceof PublicationValidationError
        || error instanceof SnapshotValidationError) {
      return response({ error: error.message }, 400);
    }
    console.error("snapshot activation failed", { error: String(error) });
    return response({ error: "database error" }, 500);
  }
}
