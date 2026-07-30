import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(here, "..");
const root = resolve(workerRoot, "..");
const zero = `xor256-v1:${"0".repeat(64)}`;
const one = `xor256-v1:${"1".repeat(64)}`;
const two = `xor256-v1:${"2".repeat(64)}`;
const hash2 = "a".repeat(64);
const hash3 = "b".repeat(64);
const snapshotID = "c".repeat(64);
const snapshotBlockID = "d".repeat(64);
const snapshotChecksum = "e".repeat(64);

let temporary;
let mf;
let db;

test.before(async () => {
  temporary = mkdtempSync(join(tmpdir(), "vocabulary-feed-reader-"));
  const bundle = join(temporary, "reader.mjs");
  const dataModule = resolve(workerRoot, "src/data.ts");
  await build({
    stdin: {
      contents: `
        import {
          getBlockSnapshotManifest, getBlockSnapshotPayload,
          getChangeFeed, getVersionedRows
        } from ${JSON.stringify(dataModule)};
        import { resolveChain } from ${JSON.stringify(resolve(workerRoot, "src/languages.ts"))};
        export default {
          async fetch(request, env) {
            const url = new URL(request.url);
            if (url.pathname === "/feed") {
              const result = await getChangeFeed(
                env, url.searchParams.get("from") || "", "full", resolveChain("en")
              );
              return new Response(JSON.stringify(result), {
                headers: { "Content-Type": "application/json" }
              });
            }
            if (url.pathname === "/rows") {
              const rows = await getVersionedRows(
                env, "nouns", ["hund"], "full", resolveChain("en"),
                url.searchParams.get("version") || ""
              );
              return new Response(JSON.stringify(rows), {
                headers: { "Content-Type": "application/json" }
              });
            }
            if (url.pathname === "/snapshot-manifest") {
              const value = await getBlockSnapshotManifest(
                env, "full", resolveChain("en"),
                url.searchParams.get("snapshot") || undefined
              );
              return new Response(JSON.stringify(value), {
                headers: { "Content-Type": "application/json" }
              });
            }
            if (url.pathname === "/snapshot-block") {
              const value = await getBlockSnapshotPayload(
                env, url.searchParams.get("snapshot") || "",
                url.searchParams.get("block") || "",
                "full", resolveChain("en")
              );
              return new Response(JSON.stringify(value && {
                metadata: value.metadata,
                payload: Array.from(value.payload)
              }), { headers: { "Content-Type": "application/json" } });
            }
            return new Response("not found", { status: 404 });
          }
        };`,
      resolveDir: workerRoot,
      sourcefile: "change-feed-harness.ts",
      loader: "ts",
    },
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  mf = new Miniflare({
    modules: true,
    script: readFileSync(bundle, "utf8"),
    d1Databases: { CONTENT_DB: "reader-test" },
    d1Persist: join(temporary, "d1"),
  });
  db = await mf.getD1Database("CONTENT_DB");
  const applySchema = async (name) => {
    const sql = readFileSync(resolve(root, `schema/${name}`), "utf8")
      .replace(/--.*$/gm, "");
    const statements = sql.split(";").map((part) => part.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
  };
  await applySchema("content_v2.sql");
  await applySchema("content_change_feed.sql");

  await db.batch([
    db.prepare(
      "INSERT INTO vocabulary_versions(sequence,base_version,dataset_generation) VALUES(1,?,2)",
    ).bind("1".repeat(64)),
    db.prepare(
      "INSERT INTO vocabulary_versions(sequence,base_version,dataset_generation) VALUES(2,?,2)",
    ).bind("2".repeat(64)),
    db.prepare(
      "INSERT INTO vocabulary_versions(sequence,base_version,dataset_generation) VALUES(3,?,2)",
    ).bind("3".repeat(64)),
    db.prepare(
      "INSERT INTO meta(key,value) VALUES('dataset_sequence','3')",
    ),
    ...[
      [1, "1".repeat(64), zero, 0],
      [2, "2".repeat(64), one, 1],
      [3, "3".repeat(64), two, 1],
    ].map(([sequence, version, fingerprint, nouns]) => db.prepare(
      `INSERT INTO vocabulary_version_views
         (sequence,scope,language,version,fingerprint,
          verbs_count,nouns_count,adverbs_adjectives_count)
       VALUES(?,'full','en',?, ?,0,?,0)`,
    ).bind(sequence, `${version}:full`, fingerprint, nouns)),
    db.prepare(
      `INSERT INTO vocabulary_change_rows
         (sequence,scope,language,table_name,word_id,operation,content_hash)
       VALUES(2,'full','en','nouns','hund','changed',?)`,
    ).bind(hash2),
    db.prepare(
      `INSERT INTO vocabulary_change_rows
         (sequence,scope,language,table_name,word_id,operation,content_hash,
          previous_content_hash)
       VALUES(3,'full','en','nouns','hund','changed',?,?)`,
    ).bind(hash3, hash2),
    db.prepare(
      `INSERT INTO vocabulary_change_rows
         (sequence,scope,language,table_name,word_id,operation,content_hash,
          previous_content_hash)
       VALUES(2,'full','en','nouns','transient','changed',?,NULL)`,
    ).bind(hash2),
    db.prepare(
      `INSERT INTO vocabulary_change_rows
         (sequence,scope,language,table_name,word_id,operation,content_hash,
          previous_content_hash)
       VALUES(3,'full','en','nouns','transient','deleted',NULL,?)`,
    ).bind(hash2),
    db.prepare(
      `INSERT INTO vocabulary_version_rows
         (sequence,scope,language,table_name,word_id,content_hash,payload_json)
       VALUES(2,'full','en','nouns','hund',?,?)`,
    ).bind(hash2, JSON.stringify({ id: "hund", content_hash: hash2, word: "Hund v2" })),
    db.prepare(
      `INSERT INTO vocabulary_version_rows
         (sequence,scope,language,table_name,word_id,content_hash,payload_json)
       VALUES(3,'full','en','nouns','hund',?,?)`,
    ).bind(hash3, JSON.stringify({ id: "hund", content_hash: hash3, word: "Hund v3" })),
    db.prepare(
      `INSERT INTO vocabulary_snapshot_manifests
         (snapshot_id,sequence,base_version,version,dataset_generation,
          schema_version,scope,language,fingerprint,verbs_count,nouns_count,
          adverbs_adjectives_count,block_count,total_compressed_bytes,
          total_uncompressed_bytes,manifest_checksum)
       VALUES(?,3,?,?,2,2,'full','en',?,0,1,0,1,3,8,?)`,
    ).bind(
      snapshotID, "3".repeat(64), `${"3".repeat(64)}:full`,
      two, "f".repeat(64),
    ),
    db.prepare(
      `INSERT INTO vocabulary_snapshot_blocks
         (snapshot_id,block_id,table_name,block_index,row_count,
          compressed_bytes,uncompressed_bytes,checksum,payload,committed)
       VALUES(?,?,'nouns',0,1,3,8,?,?,1)`,
    ).bind(
      snapshotID, snapshotBlockID, snapshotChecksum,
      new Uint8Array([1, 2, 3]),
    ),
    db.prepare(
      `INSERT INTO vocabulary_snapshot_pointers(scope,language,snapshot_id)
       VALUES('full','en',?)`,
    ).bind(snapshotID),
  ]);
});

test.after(async () => {
  await mf?.dispose();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

test("coalesces missed versions to the latest deterministic operation", async () => {
  const response = await mf.dispatchFetch(
    `https://reader.test/feed?from=${"1".repeat(64)}:full`,
  );
  const result = await response.json();
  assert.equal(result.kind, "ok");
  assert.equal(result.feed.change_set_count, 2);
  assert.equal(result.feed.from_sequence, 1);
  assert.equal(result.feed.to_sequence, 3);
  assert.equal(result.feed.changed_count, 1);
  assert.equal(result.feed.deleted_count, 0);
  assert.deepEqual(result.feed.changed, [{
    table: "nouns",
    rows: [{ id: "hund", content_hash: hash3 }],
  }]);
  assert.deepEqual(result.feed.deleted, []);
});

test("version-pinned rows remain exact after a later publication", async () => {
  const response = await mf.dispatchFetch(
    `https://reader.test/rows?version=${"2".repeat(64)}:full`,
  );
  const rows = await response.json();
  assert.deepEqual(rows, [{ id: "hund", content_hash: hash2, word: "Hund v2" }]);
});

test("unknown and expired cursors select recovery without scanning catalogue", async () => {
  const response = await mf.dispatchFetch(
    `https://reader.test/feed?from=${"9".repeat(64)}:full`,
  );
  const result = await response.json();
  assert.deepEqual(result, {
    kind: "unavailable",
    status: 410,
    reason: "history gap or expired cursor",
  });
});

test("block manifest carries its frozen publication cursor and exact metadata", async () => {
  const response = await mf.dispatchFetch(
    "https://reader.test/snapshot-manifest",
  );
  const manifest = await response.json();
  assert.equal(manifest.snapshot_id, snapshotID);
  assert.equal(manifest.sequence, 3);
  assert.equal(manifest.version, `${"3".repeat(64)}:full`);
  assert.equal(manifest.block_count, 1);
  assert.deepEqual(manifest.blocks, [{
    id: snapshotBlockID,
    table: "nouns",
    index: 0,
    row_count: 1,
    compressed_bytes: 3,
    uncompressed_bytes: 8,
    checksum: snapshotChecksum,
  }]);

  const retained = await mf.dispatchFetch(
    `https://reader.test/snapshot-manifest?snapshot=${snapshotID}`);
  assert.equal((await retained.json()).snapshot_id, snapshotID);
  const missing = await mf.dispatchFetch(
    `https://reader.test/snapshot-manifest?snapshot=${"f".repeat(64)}`);
  assert.equal(await missing.json(), null);
});

test("frozen block lookup returns only its exact committed bytes", async () => {
  const response = await mf.dispatchFetch(
    `https://reader.test/snapshot-block?snapshot=${snapshotID}&block=${snapshotBlockID}`,
  );
  const value = await response.json();
  assert.deepEqual(value.payload, [1, 2, 3]);
  assert.equal(value.metadata.checksum, snapshotChecksum);

  const missing = await mf.dispatchFetch(
    `https://reader.test/snapshot-block?snapshot=${snapshotID}&block=${"9".repeat(64)}`,
  );
  assert.equal(await missing.json(), null);
});
