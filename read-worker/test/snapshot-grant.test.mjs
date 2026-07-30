import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let temporary;
let grants;

test.before(async () => {
  // Cloudflare WebCrypto exposes subtle.timingSafeEqual; Node's WebCrypto does
  // not, so provide the equivalent only inside this contract test.
  if (!globalThis.crypto.subtle.timingSafeEqual) {
    globalThis.crypto.subtle.timingSafeEqual = (left, right) => {
      const a = Buffer.from(left);
      const b = Buffer.from(right);
      return a.byteLength === b.byteLength && timingSafeEqual(a, b);
    };
  }
  temporary = mkdtempSync(join(tmpdir(), "snapshot-grant-"));
  const output = join(temporary, "grant.mjs");
  await build({
    entryPoints: [resolve("src/snapshot-grant.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  grants = await import(pathToFileURL(output).href);
});

test.after(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

test("grant is bound to subject, scope, language, snapshot and expiry", async () => {
  const session = {
    sub: "device-1",
    ent: "storekit",
    scope: "full",
    iat: 900,
    exp: 2_000,
  };
  const snapshot = "a".repeat(64);
  const token = await grants.mintSnapshotGrant(
    "current-secret", session, snapshot, "en", 1_000);
  assert.equal(await grants.verifySnapshotGrant(
    ["current-secret"], token, session, snapshot, "en", 1_001), true);
  assert.equal(await grants.verifySnapshotGrant(
    ["current-secret"], token, { ...session, sub: "device-2" },
    snapshot, "en", 1_001), false);
  assert.equal(await grants.verifySnapshotGrant(
    ["current-secret"], token, { ...session, scope: "free" },
    snapshot, "en", 1_001), false);
  assert.equal(await grants.verifySnapshotGrant(
    ["current-secret"], token, session, "b".repeat(64), "en", 1_001), false);
  assert.equal(await grants.verifySnapshotGrant(
    ["current-secret"], token, session, snapshot, "es-419", 1_001), false);
  assert.equal(await grants.verifySnapshotGrant(
    ["current-secret"], token, session, snapshot, "en", 2_000), false);
});

test("rotation accepts previous secret and tampering fails closed", async () => {
  const session = {
    sub: "device-1",
    ent: "storekit",
    scope: "full",
    iat: 100,
    exp: 10_000,
  };
  const snapshot = "c".repeat(64);
  const token = await grants.mintSnapshotGrant(
    "previous-secret", session, snapshot, "en", 200);
  assert.equal(await grants.verifySnapshotGrant(
    ["new-secret", "previous-secret"],
    token, session, snapshot, "en", 201), true);
  const [payload, signature] = token.split(".");
  const tampered = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
  assert.equal(await grants.verifySnapshotGrant(
    ["previous-secret"], tampered, session, snapshot, "en", 201), false);
  assert.equal(await grants.verifySnapshotGrant(
    ["previous-secret"], "not-a-grant", session, snapshot, "en", 201), false);
});
