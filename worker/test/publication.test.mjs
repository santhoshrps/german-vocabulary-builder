import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const workerRoot = resolve(here, "..");
const secret = "publication-test-secret";
const languages = ["en", "en-US", "es-419", "es-MX", "es-ES", "zh"];
const scopes = ["free", "full"];
const zeroFingerprint = `xor256-v1:${"0".repeat(64)}`;
const emptyCounts = { verbs: 0, nouns: 0, adverbs_adjectives: 0 };

let temporary;
let mf;
let db;

function views(mapper) {
  return languages.flatMap((language) =>
    scopes.map((scope) => ({ language, scope, ...mapper(scope, language) })));
}

function physical(groups = {}) {
  return ["verbs", "nouns", "adverbs_adjectives", "translations", "id_aliases"]
    .map((table) => ({
      table,
      upsert: groups[table]?.upsert ?? [],
      delete: groups[table]?.delete ?? [],
    }));
}

function noun(contentHash, complete = true) {
  return complete ? {
    id: "hund",
    content_hash: contentHash,
    free: 0,
    level: "A1",
    capital: null,
    type: "noun",
    article: "der",
    word: "Hund",
    plural: "Hunde",
    sense: null,
    image: 0,
    german_sentence: "Der Hund bellt.",
  } : { id: "hund", content_hash: contentHash };
}

function translation(contentHash) {
  return {
    id: "hund:en",
    content_hash: contentHash,
    word_id: "hund",
    lang: "en",
    word: "dog",
    sentence: "The dog barks.",
    article: null,
    article_plural: null,
    plural: null,
  };
}

function contribution(table, id, contentHash) {
  return createHash("sha256")
    .update(`${table}\0${id}\0${contentHash}`)
    .digest();
}

function projectedFingerprint(...contributions) {
  const bytes = Buffer.alloc(32);
  for (const item of contributions) {
    for (let index = 0; index < bytes.length; index++) bytes[index] ^= item[index];
  }
  return `xor256-v1:${bytes.toString("hex")}`;
}

async function signedFetch(path, method = "GET", body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash("sha256").update(text).digest("hex");
  const canonical = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return mf.dispatchFetch(`https://writer.test${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    },
    body: method === "GET" ? undefined : text,
  });
}

test.before(async () => {
  temporary = mkdtempSync(join(tmpdir(), "vocabulary-publication-"));
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
    d1Databases: { CONTENT_DB: "publication-test" },
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
});

test.after(async () => {
  await mf?.dispose();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

test("word mutations, immutable history and pointer commit atomically", async () => {
  const baseline = {
    contract_version: 1,
    target_base_version: "1".repeat(64),
    dataset_generation: 2,
    views: views(() => ({
      target_fingerprint: zeroFingerprint,
      target_counts: emptyCounts,
    })),
  };
  let response = await signedFetch("/publication/baseline", "POST", baseline);
  assert.equal(response.status, 200, await response.text());

  const physicalHash = "a".repeat(64);
  const translationHash = "b".repeat(64);
  const servedHash = "c".repeat(64);
  const targetFingerprint = projectedFingerprint(
    contribution("nouns", "hund", servedHash),
  );
  const servedRow = {
    ...noun(physicalHash),
    content_hash: servedHash,
    english: "dog",
    english_sentence: "The dog barks.",
    translation_article: null,
    translation_article_plural: null,
    translation_plural: null,
  };
  const commit = {
    contract_version: 1,
    from_base_version: "1".repeat(64),
    target_base_version: "2".repeat(64),
    dataset_generation: 2,
    physical: physical({
      nouns: { upsert: [noun(physicalHash)] },
      translations: { upsert: [translation(translationHash)] },
    }),
    views: views((scope) => ({
      from_fingerprint: zeroFingerprint,
      target_fingerprint: scope === "full" ? targetFingerprint : zeroFingerprint,
      from_counts: emptyCounts,
      target_counts: scope === "full"
        ? { ...emptyCounts, nouns: 1 } : emptyCounts,
      changed: scope === "full" ? [{
        table: "nouns",
        id: "hund",
        content_hash: servedHash,
        previous_content_hash: null,
        row: servedRow,
      }] : [],
      deleted: [],
      aliases: [],
      type_changes: [],
    })),
  };
  response = await signedFetch("/publication/commit", "POST", commit);
  assert.equal(response.status, 200, await response.text());

  const cursor = await db.prepare(
    "SELECT sequence, base_version FROM vocabulary_versions ORDER BY sequence DESC LIMIT 1",
  ).first();
  assert.deepEqual(cursor, { sequence: 2, base_version: "2".repeat(64) });
  assert.equal(
    (await db.prepare("SELECT content_hash FROM nouns WHERE id='hund'").first()).content_hash,
    physicalHash,
  );
  assert.equal(
    (await db.prepare(
      "SELECT COUNT(*) AS count FROM vocabulary_change_rows WHERE sequence=2",
    ).first()).count,
    languages.length,
  );
  assert.equal(
    (await db.prepare(
      "SELECT COUNT(*) AS count FROM vocabulary_version_rows WHERE sequence=2",
    ).first()).count,
    languages.length,
  );
  response = await signedFetch("/publication/audit");
  const auditBody = await response.json();
  assert.equal(response.status, 200, JSON.stringify(auditBody));
  assert.deepEqual(auditBody, {
    status: "ok",
    retained_versions: 2,
    transitions: languages.length * scopes.length,
  });

  // Exact replay is rejected before mutation and creates no duplicate history.
  response = await signedFetch("/publication/commit", "POST", commit);
  assert.equal(response.status, 409);
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS count FROM vocabulary_versions").first()).count,
    2,
  );

  // Inject a D1 NOT NULL failure after validation. D1Database.batch must roll
  // back the attempted word update, history rows and pointer together.
  const broken = structuredClone(commit);
  broken.from_base_version = "2".repeat(64);
  broken.target_base_version = "3".repeat(64);
  broken.physical = physical({
    nouns: { upsert: [{ ...noun("e".repeat(64)), level: null }] },
  });
  const brokenServedHash = "f".repeat(64);
  const brokenFingerprint = projectedFingerprint(
    contribution("nouns", "hund", brokenServedHash),
  );
  broken.views = views((scope) => ({
    from_fingerprint: scope === "full" ? targetFingerprint : zeroFingerprint,
    target_fingerprint: scope === "full" ? brokenFingerprint : zeroFingerprint,
    from_counts: scope === "full"
      ? { ...emptyCounts, nouns: 1 } : emptyCounts,
    target_counts: scope === "full"
      ? { ...emptyCounts, nouns: 1 } : emptyCounts,
    changed: scope === "full" ? [{
      table: "nouns",
      id: "hund",
      content_hash: brokenServedHash,
      previous_content_hash: servedHash,
      row: { ...servedRow, content_hash: brokenServedHash },
    }] : [],
    deleted: [],
    aliases: [],
    type_changes: [],
  }));
  response = await signedFetch("/publication/commit", "POST", broken);
  assert.equal(response.status, 500);
  assert.equal(
    (await db.prepare(
      "SELECT value FROM meta WHERE key='dataset_version'",
    ).first()).value,
    "2".repeat(64),
  );
  assert.equal(
    (await db.prepare("SELECT content_hash FROM nouns WHERE id='hund'").first()).content_hash,
    physicalHash,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS count FROM vocabulary_versions").first()).count,
    2,
  );
});

test("malformed duplicate/conflicting ids fail before database mutation", async () => {
  const before = (await db.prepare(
    "SELECT COUNT(*) AS count FROM vocabulary_versions",
  ).first()).count;
  const response = await signedFetch("/publication/commit", "POST", {
    contract_version: 1,
    from_base_version: "2".repeat(64),
    target_base_version: "4".repeat(64),
    dataset_generation: 2,
    physical: physical({
      nouns: {
        upsert: [noun("1".repeat(64))],
        delete: ["hund"],
      },
    }),
    views: [],
  });
  assert.equal(response.status, 400);
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS count FROM vocabulary_versions").first()).count,
    before,
  );
});
