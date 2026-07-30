interface SnapshotPublicationEnv {
  CONTENT_DB: D1Database;
}

const CONTRACT_VERSION = 1;
const SCHEMA_VERSION = 2;
const EXPECTED_COMPRESSION = "zlib";
const EXPECTED_LANGUAGES = ["en", "en-US", "es-419", "es-MX", "es-ES", "zh"];
const EXPECTED_SCOPES = ["free", "full"];
const TABLES = ["verbs", "nouns", "adverbs_adjectives"] as const;
const SHA256 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^xor256-v1:[0-9a-f]{64}$/;
const MAX_BLOCK_BYTES = 4 * 1024 * 1024;
const MAX_BLOCKS_PER_SNAPSHOT = 2_000;

export type SnapshotCounts = {
  verbs: number;
  nouns: number;
  adverbs_adjectives: number;
};

export type SnapshotViewMetadata = {
  scope: string;
  language: string;
  target_fingerprint: string;
  target_counts: SnapshotCounts;
};

export type SnapshotBlockMetadata = {
  id: string;
  table: string;
  index: number;
  row_count: number;
  compressed_bytes: number;
  uncompressed_bytes: number;
  checksum: string;
};

export type SnapshotManifest = {
  contract_version: number;
  snapshot_id: string;
  dataset_generation: number;
  base_version: string;
  version: string;
  language: string;
  scope: string;
  schema_version: number;
  compression: string;
  total_count: number;
  table_counts: SnapshotCounts;
  global_fingerprint: string;
  block_count: number;
  total_compressed_bytes: number;
  total_uncompressed_bytes: number;
  blocks: SnapshotBlockMetadata[];
  manifest_checksum: string;
};

type SnapshotBlockUpload = SnapshotBlockMetadata & {
  contract_version: number;
  snapshot_id: string;
  payload_base64: string;
};

class SnapshotValidationError extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_BLOCK_BYTES / 3) * 4 + 16) {
    throw new SnapshotValidationError("snapshot block exceeds encoded size cap");
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new SnapshotValidationError("invalid snapshot block base64");
  }
}

function requirePositiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new SnapshotValidationError(`${label}: invalid positive integer`);
  }
  return Number(value);
}

function validateBlockMetadata(value: unknown): SnapshotBlockMetadata {
  if (!isObject(value)
      || typeof value.id !== "string" || !SHA256.test(value.id)
      || !TABLES.includes(value.table as typeof TABLES[number])
      || !Number.isSafeInteger(value.index) || Number(value.index) < 0
      || typeof value.checksum !== "string" || !SHA256.test(value.checksum)) {
    throw new SnapshotValidationError("invalid snapshot block metadata");
  }
  const rowCount = requirePositiveInteger(value.row_count, "row_count", 1_000);
  const compressedBytes = requirePositiveInteger(
    value.compressed_bytes, "compressed_bytes", MAX_BLOCK_BYTES);
  const uncompressedBytes = requirePositiveInteger(
    value.uncompressed_bytes, "uncompressed_bytes", 32 * 1024 * 1024);
  return {
    id: value.id,
    table: value.table as typeof TABLES[number],
    index: Number(value.index),
    row_count: rowCount,
    compressed_bytes: compressedBytes,
    uncompressed_bytes: uncompressedBytes,
    checksum: value.checksum,
  };
}

function validateCounts(value: unknown): SnapshotCounts {
  if (!isObject(value)) throw new SnapshotValidationError("invalid snapshot counts");
  const result = {} as SnapshotCounts;
  for (const table of TABLES) {
    if (!Number.isSafeInteger(value[table])
        || Number(value[table]) < 0 || Number(value[table]) > 1_000_000) {
      throw new SnapshotValidationError(`invalid snapshot count for ${table}`);
    }
    result[table] = Number(value[table]);
  }
  return result;
}

async function validateManifestChecksum(manifest: SnapshotManifest): Promise<void> {
  const unsigned = { ...manifest } as Record<string, unknown>;
  delete unsigned.manifest_checksum;
  const digest = await sha256Hex(new TextEncoder().encode(canonicalJSON(unsigned)));
  if (digest !== manifest.manifest_checksum) {
    throw new SnapshotValidationError("snapshot manifest checksum mismatch");
  }
}

function viewKey(scope: string, language: string): string {
  return `${scope}\0${language}`;
}

export async function validateSnapshotManifests(
  env: SnapshotPublicationEnv,
  value: unknown,
  options: {
    baseVersion: string;
    generation: number;
    views: SnapshotViewMetadata[];
  },
): Promise<SnapshotManifest[]> {
  const { baseVersion, generation, views } = options;
  if (!Array.isArray(value) || value.length !== EXPECTED_LANGUAGES.length * EXPECTED_SCOPES.length) {
    throw new SnapshotValidationError("publication requires every snapshot language/scope view");
  }
  const viewMap = new Map(views.map((view) => [viewKey(view.scope, view.language), view]));
  const result: SnapshotManifest[] = [];
  const snapshotIDs = new Set<string>();

  for (const raw of value) {
    if (!isObject(raw)) throw new SnapshotValidationError("invalid snapshot manifest");
    const manifest = raw as unknown as SnapshotManifest;
    if (manifest.contract_version !== CONTRACT_VERSION
        || manifest.schema_version !== SCHEMA_VERSION
        || manifest.compression !== EXPECTED_COMPRESSION
        || typeof manifest.snapshot_id !== "string" || !SHA256.test(manifest.snapshot_id)
        || typeof manifest.manifest_checksum !== "string" || !SHA256.test(manifest.manifest_checksum)
        || manifest.base_version !== baseVersion
        || manifest.version !== `${baseVersion}:${manifest.scope}`
        || manifest.dataset_generation !== generation
        || !EXPECTED_SCOPES.includes(manifest.scope)
        || !EXPECTED_LANGUAGES.includes(manifest.language)
        || typeof manifest.global_fingerprint !== "string"
        || !FINGERPRINT.test(manifest.global_fingerprint)
        || snapshotIDs.has(manifest.snapshot_id)) {
      throw new SnapshotValidationError("invalid snapshot manifest identity");
    }
    const expectedSnapshotID = await sha256Hex(new TextEncoder().encode(
      `snapshot-v${CONTRACT_VERSION}\0schema-${SCHEMA_VERSION}\0`
      + `${generation}\0${baseVersion}\0${manifest.language}\0`
      + `${manifest.scope}\0${manifest.global_fingerprint}`,
    ));
    if (manifest.snapshot_id !== expectedSnapshotID) {
      throw new SnapshotValidationError("snapshot id is not content-addressed");
    }
    snapshotIDs.add(manifest.snapshot_id);
    const view = viewMap.get(viewKey(manifest.scope, manifest.language));
    const counts = validateCounts(manifest.table_counts);
    if (!view
        || view.target_fingerprint !== manifest.global_fingerprint
        || TABLES.some((table) => view.target_counts[table] !== counts[table])) {
      throw new SnapshotValidationError("snapshot manifest does not match publication view");
    }
    if (!Array.isArray(manifest.blocks)
        || manifest.blocks.length === 0
        || manifest.blocks.length > MAX_BLOCKS_PER_SNAPSHOT
        || manifest.block_count !== manifest.blocks.length) {
      throw new SnapshotValidationError("invalid snapshot block count");
    }
    const blocks = manifest.blocks.map(validateBlockMetadata);
    const blockIDs = new Set<string>();
    const positions = new Set<string>();
    const indexes = new Map<string, Set<number>>(
      TABLES.map((table) => [table, new Set<number>()]),
    );
    const summedCounts: SnapshotCounts = {
      verbs: 0, nouns: 0, adverbs_adjectives: 0,
    };
    let compressed = 0;
    let uncompressed = 0;
    for (const block of blocks) {
      if (blockIDs.has(block.id)
          || positions.has(`${block.table}\0${block.index}`)) {
        throw new SnapshotValidationError("duplicate snapshot block");
      }
      const expectedBlockID = await sha256Hex(new TextEncoder().encode(
        `${manifest.snapshot_id}\0${block.table}\0${block.index}\0${block.checksum}`,
      ));
      if (block.id !== expectedBlockID) {
        throw new SnapshotValidationError("snapshot block id is not content-addressed");
      }
      blockIDs.add(block.id);
      positions.add(`${block.table}\0${block.index}`);
      indexes.get(block.table)?.add(block.index);
      summedCounts[block.table as keyof SnapshotCounts] += block.row_count;
      compressed += block.compressed_bytes;
      uncompressed += block.uncompressed_bytes;
    }
    for (const table of TABLES) {
      const values = [...(indexes.get(table) ?? [])].sort((a, b) => a - b);
      if (values.some((value, index) => value !== index)) {
        throw new SnapshotValidationError("snapshot block positions are not contiguous");
      }
    }
    const total = counts.verbs + counts.nouns + counts.adverbs_adjectives;
    if (manifest.total_count !== total
        || TABLES.some((table) => summedCounts[table] !== counts[table])
        || manifest.total_compressed_bytes !== compressed
        || manifest.total_uncompressed_bytes !== uncompressed) {
      throw new SnapshotValidationError("snapshot manifest totals mismatch");
    }
    const uploaded = await env.CONTENT_DB.prepare(
      `SELECT block_id, table_name, block_index, row_count, compressed_bytes,
              uncompressed_bytes, checksum, length(payload) AS payload_bytes,
              committed
         FROM vocabulary_snapshot_blocks WHERE snapshot_id = ?`,
    ).bind(manifest.snapshot_id).all<Record<string, unknown>>();
    if (uploaded.results.length !== blocks.length) {
      throw new SnapshotValidationError("snapshot upload is incomplete");
    }
    const uploadedMap = new Map(uploaded.results.map((row) => [String(row.block_id), row]));
    for (const block of blocks) {
      const row = uploadedMap.get(block.id);
      if (!row
          || row.table_name !== block.table
          || Number(row.block_index) !== block.index
          || Number(row.row_count) !== block.row_count
          || Number(row.compressed_bytes) !== block.compressed_bytes
          || Number(row.uncompressed_bytes) !== block.uncompressed_bytes
          || row.checksum !== block.checksum
          || Number(row.payload_bytes) !== block.compressed_bytes
          || Number(row.committed) !== 0) {
        throw new SnapshotValidationError("uploaded snapshot block metadata mismatch");
      }
    }
    await validateManifestChecksum({ ...manifest, table_counts: counts, blocks });
    result.push({ ...manifest, table_counts: counts, blocks });
  }
  return result;
}

export function snapshotActivationStatements(
  env: SnapshotPublicationEnv,
  manifests: SnapshotManifest[],
  sequence: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const manifest of manifests) {
    statements.push(
      env.CONTENT_DB.prepare(
        `INSERT INTO vocabulary_snapshot_manifests
           (snapshot_id, sequence, base_version, version, dataset_generation,
            schema_version, scope, language, fingerprint, verbs_count,
            nouns_count, adverbs_adjectives_count, block_count,
            total_compressed_bytes, total_uncompressed_bytes, manifest_checksum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        manifest.snapshot_id,
        sequence,
        manifest.base_version,
        manifest.version,
        manifest.dataset_generation,
        manifest.schema_version,
        manifest.scope,
        manifest.language,
        manifest.global_fingerprint,
        manifest.table_counts.verbs,
        manifest.table_counts.nouns,
        manifest.table_counts.adverbs_adjectives,
        manifest.block_count,
        manifest.total_compressed_bytes,
        manifest.total_uncompressed_bytes,
        manifest.manifest_checksum,
      ),
      env.CONTENT_DB.prepare(
        `UPDATE vocabulary_snapshot_blocks SET committed = 1
          WHERE snapshot_id = ? AND committed = 0`,
      ).bind(manifest.snapshot_id),
      env.CONTENT_DB.prepare(
        `INSERT INTO vocabulary_snapshot_pointers(scope, language, snapshot_id)
         VALUES (?, ?, ?)
         ON CONFLICT(scope, language) DO UPDATE SET snapshot_id = excluded.snapshot_id`,
      ).bind(manifest.scope, manifest.language, manifest.snapshot_id),
    );
  }
  return statements;
}

export async function handleSnapshotBlockUpload(
  env: SnapshotPublicationEnv,
  request: Request,
): Promise<Response> {
  try {
    const raw: unknown = await request.json();
    if (!isObject(raw)) throw new SnapshotValidationError("body must be an object");
    const body = raw as unknown as SnapshotBlockUpload;
    if (body.contract_version !== CONTRACT_VERSION
        || typeof body.snapshot_id !== "string" || !SHA256.test(body.snapshot_id)
        || typeof body.payload_base64 !== "string") {
      throw new SnapshotValidationError("invalid snapshot upload identity");
    }
    const metadata = validateBlockMetadata(body);
    const payload = decodeBase64(body.payload_base64);
    const expectedBlockID = await sha256Hex(new TextEncoder().encode(
      `${body.snapshot_id}\0${metadata.table}\0${metadata.index}\0${metadata.checksum}`,
    ));
    if (payload.byteLength !== metadata.compressed_bytes
        || await sha256Hex(payload) !== metadata.checksum
        || metadata.id !== expectedBlockID) {
      throw new SnapshotValidationError("snapshot block checksum/size mismatch");
    }
    await env.CONTENT_DB.prepare(
      `INSERT INTO vocabulary_snapshot_blocks
         (snapshot_id, block_id, table_name, block_index, row_count,
          compressed_bytes, uncompressed_bytes, checksum, payload, committed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(snapshot_id, block_id) DO NOTHING`,
    ).bind(
      body.snapshot_id,
      metadata.id,
      metadata.table,
      metadata.index,
      metadata.row_count,
      metadata.compressed_bytes,
      metadata.uncompressed_bytes,
      metadata.checksum,
      payload,
    ).run();
    const stored = await env.CONTENT_DB.prepare(
      `SELECT table_name, block_index, row_count, compressed_bytes,
              uncompressed_bytes, checksum, length(payload) AS payload_bytes,
              committed
         FROM vocabulary_snapshot_blocks
        WHERE snapshot_id = ? AND block_id = ?`,
    ).bind(body.snapshot_id, metadata.id).first<Record<string, unknown>>();
    if (!stored
        || stored.table_name !== metadata.table
        || Number(stored.block_index) !== metadata.index
        || Number(stored.row_count) !== metadata.row_count
        || Number(stored.compressed_bytes) !== metadata.compressed_bytes
        || Number(stored.uncompressed_bytes) !== metadata.uncompressed_bytes
        || stored.checksum !== metadata.checksum
        || Number(stored.payload_bytes) !== payload.byteLength
        || Number(stored.committed) !== 0) {
      return json({ error: "conflicting immutable snapshot block" }, 409);
    }
    return json({ status: "verified", snapshot_id: body.snapshot_id, block_id: metadata.id });
  } catch (error) {
    if (error instanceof SnapshotValidationError) {
      return json({ error: error.message }, 400);
    }
    console.error("snapshot block upload failed", { error: String(error) });
    return json({ error: "database error" }, 500);
  }
}

export { SnapshotValidationError };
