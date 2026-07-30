import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const workerRoot = resolve(here, "..");
const secret = "snapshot-publication-test-secret";
const languages = ["en", "en-US", "es-419", "es-MX", "es-ES", "zh"];
const scopes = ["free", "full"];
const baseVersion = "b".repeat(64);
const fingerprint = `xor256-v1:${"1".repeat(64)}`;

let temporary;
let mf;
let db;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function signedFetch(path, body) {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = sha(text);
  const signature = createHmac("sha256", secret)
    .update(`POST\n${path}\n${timestamp}\n${bodyHash}`)
    .digest("hex");
  return mf.dispatchFetch(`https://writer.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    },
    body: text,
  });
}

async function signedGet(path) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = sha("");
  const signature = createHmac("sha256", secret)
    .update(`GET\n${path}\n${timestamp}\n${bodyHash}`)
    .digest("hex");
  return mf.dispatchFetch(`https://writer.test${path}`, {
    headers: {
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    },
  });
}

function fixture(language, scope, salt = "", fingerprintOverride = null) {
  const targetBaseVersion = salt ? sha(`base:${salt}`) : baseVersion;
  const targetFingerprint = fingerprintOverride ?? (salt
    ? `xor256-v1:${sha(`fingerprint:${salt}`)}`
    : fingerprint);
  const snapshotID = sha(
    `snapshot-v1\0schema-2\0${2}\0${targetBaseVersion}\0`
    + `${language}\0${scope}\0${targetFingerprint}`,
  );
  const raw = Buffer.from(`immutable:${language}:${scope}:${salt}`);
  const payload = deflateSync(raw);
  const checksum = sha(payload);
  const block = {
    id: sha(`${snapshotID}\0nouns\0${0}\0${checksum}`),
    table: "nouns",
    index: 0,
    row_count: 1,
    compressed_bytes: payload.byteLength,
    uncompressed_bytes: raw.byteLength,
    checksum,
  };
  const manifest = {
    contract_version: 1,
    snapshot_id: snapshotID,
    dataset_generation: 2,
    base_version: targetBaseVersion,
    version: `${targetBaseVersion}:${scope}`,
    language,
    scope,
    schema_version: 2,
    compression: "zlib",
    total_count: 1,
    table_counts: {
      verbs: 0,
      nouns: 1,
      adverbs_adjectives: 0,
    },
    global_fingerprint: targetFingerprint,
    block_count: 1,
    total_compressed_bytes: payload.byteLength,
    total_uncompressed_bytes: raw.byteLength,
    blocks: [block],
  };
  manifest.manifest_checksum = sha(canonical(manifest));
  return {
    manifest,
    upload: {
      contract_version: 1,
      snapshot_id: snapshotID,
      ...block,
      payload_base64: payload.toString("base64"),
    },
  };
}

function emptyPhysical() {
  return ["verbs", "nouns", "adverbs_adjectives", "translations", "id_aliases"]
    .map((table) => ({ table, upsert: [], delete: [] }));
}

function toggleFingerprint(encoded, table, id, ...hashes) {
  const bytes = Buffer.from(encoded.slice("xor256-v1:".length), "hex");
  for (const hash of hashes) {
    const contribution = createHash("sha256")
      .update(`${table}\0${id}\0${hash}`)
      .digest();
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] ^= contribution[index];
    }
  }
  return `xor256-v1:${bytes.toString("hex")}`;
}

test.before(async () => {
  temporary = mkdtempSync(join(tmpdir(), "snapshot-publication-"));
  const bundle = join(temporary, "worker.mjs");
  await build({
    entryPoints: [resolve(workerRoot, "src/index.ts")],
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  mf = new Miniflare({
    modules: true,
    script: readFileSync(bundle, "utf8"),
    bindings: { API_KEY: secret, ENV_NAME: "test" },
    d1Databases: { CONTENT_DB: "snapshot-publication-test" },
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
      `INSERT INTO vocabulary_versions
         (sequence,base_version,dataset_generation) VALUES(1,?,2)`,
    ).bind(baseVersion),
    db.prepare(
      "INSERT INTO meta(key,value) VALUES('dataset_sequence','1')",
    ),
    db.prepare(
      "INSERT INTO meta(key,value) VALUES('dataset_version',?)",
    ).bind(baseVersion),
    ...languages.flatMap((language) => scopes.map((scope) => db.prepare(
      `INSERT INTO vocabulary_version_views
         (sequence,scope,language,version,fingerprint,
          verbs_count,nouns_count,adverbs_adjectives_count)
       VALUES(1,?,?,?, ?,0,1,0)`,
    ).bind(scope, language, `${baseVersion}:${scope}`, fingerprint))),
  ]);
});

test.after(async () => {
  await mf?.dispose();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

test("all blocks remain invisible until every manifest activates atomically", async () => {
  const fixtures = languages.flatMap((language) =>
    scopes.map((scope) => fixture(language, scope)));
  for (const item of fixtures) {
    const response = await signedFetch(
      "/publication/snapshot-block", item.upload);
    assert.equal(response.status, 200, await response.text());
  }
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_snapshot_pointers",
  ).first()).count, 0);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_snapshot_blocks WHERE committed=1",
  ).first()).count, 0);

  const response = await signedFetch("/publication/snapshot-activate", {
    contract_version: 1,
    target_base_version: baseVersion,
    dataset_generation: 2,
    snapshots: fixtures.map((item) => item.manifest),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_snapshot_pointers",
  ).first()).count, fixtures.length);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_snapshot_blocks WHERE committed=1",
  ).first()).count, fixtures.length);
  const stateResponse = await signedGet("/publication/state");
  const state = await stateResponse.json();
  assert.equal(stateResponse.status, 200, JSON.stringify(state));
  assert.equal(state.snapshot_views_available, fixtures.length);
  assert.equal(state.oldest_snapshot_sequence, 1);

  // Exact block replay is idempotent after activation.
  const replay = await signedFetch(
    "/publication/snapshot-block", fixtures[0].upload);
  assert.equal(replay.status, 409);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_snapshot_blocks",
  ).first()).count, fixtures.length);
});

test("missing, corrupt and conflicting immutable inputs never move pointers", async () => {
  const before = (await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_snapshot_pointers",
  ).first()).count;
  const fixtures = languages.flatMap((language) =>
    scopes.map((scope) => fixture(language, scope, "missing")));
  const targetBaseVersion = fixtures[0].manifest.base_version;
  const targetFingerprint = fixtures[0].manifest.global_fingerprint;
  await db.batch([
    db.prepare(
      `INSERT INTO vocabulary_versions
         (sequence,base_version,dataset_generation) VALUES(2,?,2)`,
    ).bind(targetBaseVersion),
    db.prepare(
      "UPDATE meta SET value='2' WHERE key='dataset_sequence'",
    ),
    db.prepare(
      "UPDATE meta SET value=? WHERE key='dataset_version'",
    ).bind(targetBaseVersion),
    ...languages.flatMap((language) => scopes.map((scope) => db.prepare(
      `INSERT INTO vocabulary_version_views
         (sequence,scope,language,version,fingerprint,
          verbs_count,nouns_count,adverbs_adjectives_count)
       VALUES(2,?,?,?, ?,0,1,0)`,
    ).bind(
      scope,
      language,
      `${targetBaseVersion}:${scope}`,
      targetFingerprint,
    ))),
  ]);
  const corrupt = structuredClone(fixtures[0].upload);
  corrupt.payload_base64 = Buffer.from("different").toString("base64");
  const corruptResponse = await signedFetch(
    "/publication/snapshot-block", corrupt);
  assert.equal(corruptResponse.status, 400);

  const missingResponse = await signedFetch(
    "/publication/snapshot-activate", {
      contract_version: 1,
      target_base_version: targetBaseVersion,
      dataset_generation: 2,
      snapshots: fixtures.map((item) => item.manifest),
    });
  assert.equal(missingResponse.status, 400);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_snapshot_pointers",
  ).first()).count, before);
});

test("boundary refresh prunes only superseded snapshots before history", async () => {
  const current = fixture("en", "full", "missing").manifest;
  await db.batch([
    db.prepare(
      "DELETE FROM vocabulary_version_views WHERE sequence=2",
    ),
    db.prepare(
      "DELETE FROM vocabulary_versions WHERE sequence=2",
    ),
    db.prepare(
      `INSERT INTO vocabulary_versions
         (sequence,base_version,dataset_generation) VALUES(256,?,2)`,
    ).bind(current.base_version),
    db.prepare(
      "UPDATE meta SET value='256' WHERE key='dataset_sequence'",
    ),
    ...languages.flatMap((language) => scopes.map((scope) => db.prepare(
      `INSERT INTO vocabulary_version_views
         (sequence,scope,language,version,fingerprint,
          verbs_count,nouns_count,adverbs_adjectives_count)
       VALUES(256,?,?,?, ?,0,1,0)`,
    ).bind(
      scope,
      language,
      `${current.base_version}:${scope}`,
      current.global_fingerprint,
    ))),
  ]);

  const rowID = "retention-word";
  const previousHash = "2".repeat(64);
  const nextHash = "3".repeat(64);
  const nextFingerprint = toggleFingerprint(
    current.global_fingerprint, "nouns", rowID, previousHash, nextHash);
  const replacements = languages.flatMap((language) =>
    scopes.map((scope) =>
      fixture(language, scope, "retention", nextFingerprint)));
  for (const item of replacements) {
    const upload = await signedFetch(
      "/publication/snapshot-block", item.upload);
    assert.equal(upload.status, 200, await upload.text());
  }
  const target = replacements[0].manifest;
  const response = await signedFetch("/publication/commit", {
    contract_version: 1,
    from_base_version: current.base_version,
    target_base_version: target.base_version,
    dataset_generation: 2,
    physical: emptyPhysical().map((group) => group.table === "nouns" ? {
      ...group,
      upsert: [{
        id: rowID,
        content_hash: nextHash,
        free: 1,
        level: "A1",
        capital: null,
        type: "noun",
        article: "das",
        word: "Wort",
        plural: "Wörter",
        sense: null,
        image: 0,
        german_sentence: "Das ist ein Wort.",
      }],
    } : group),
    views: languages.flatMap((language) => scopes.map((scope) => ({
      language,
      scope,
      from_fingerprint: current.global_fingerprint,
      target_fingerprint: target.global_fingerprint,
      from_counts: { verbs: 0, nouns: 1, adverbs_adjectives: 0 },
      target_counts: { verbs: 0, nouns: 1, adverbs_adjectives: 0 },
      changed: [{
        table: "nouns",
        id: rowID,
        content_hash: nextHash,
        previous_content_hash: previousHash,
        row: {
          id: rowID,
          content_hash: nextHash,
          free: 1,
          level: "A1",
          capital: null,
          type: "noun",
          article: "das",
          word: "Wort",
          plural: "Wörter",
          sense: null,
          image: 0,
          german_sentence: "Das ist ein Wort.",
          english: "word",
          english_sentence: "This is a word.",
          translation_article: null,
          translation_article_plural: null,
          translation_plural: null,
        },
      }],
      deleted: [],
      aliases: [],
      type_changes: [],
    }))),
    snapshots: replacements.map((item) => item.manifest),
  });
  assert.equal(response.status, 200, await response.text());

  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_versions WHERE sequence=1",
  ).first()).count, 0);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_snapshot_manifests WHERE sequence=1",
  ).first()).count, 0);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_snapshot_pointers",
  ).first()).count, replacements.length);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_snapshot_manifests WHERE sequence=257",
  ).first()).count, replacements.length);
});
