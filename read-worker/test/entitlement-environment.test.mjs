import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let temporary;
let contract;

test.before(async () => {
  if (!globalThis.crypto.subtle.timingSafeEqual) {
    globalThis.crypto.subtle.timingSafeEqual = (left, right) => {
      const a = Buffer.from(left);
      const b = Buffer.from(right);
      return a.byteLength === b.byteLength && timingSafeEqual(a, b);
    };
  }
  temporary = mkdtempSync(join(tmpdir(), "storekit-environment-"));
  const output = join(temporary, "contract.mjs");
  await build({
    stdin: {
      contents: `
        export * from ${JSON.stringify(resolve("src/storekit-environment.ts"))};
        export { validateTransactionClaims } from ${JSON.stringify(resolve("src/entitlement.ts"))};
        export { signSession, verifySession, issuerFor } from ${JSON.stringify(resolve("src/jwt.ts"))};
        export { mintSnapshotGrant, verifySnapshotGrant } from ${JSON.stringify(resolve("src/snapshot-grant.ts"))};
        export { healthReport } from ${JSON.stringify(resolve("src/health.ts"))};
      `,
      resolveDir: process.cwd(),
      sourcefile: "storekit-environment-harness.ts",
      loader: "ts",
    },
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  contract = await import(pathToFileURL(output).href);
});

test.after(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

function env(overrides = {}) {
  return {
    CONTENT_DB: {},
    OPS_DB: {},
    ENV_NAME: "prod",
    APP_TEAM_ID: "TEAM",
    APP_BUNDLE_ID: "com.example.words",
    ENTITLEMENT_PRODUCT_IDS: "com.example.words.full",
    SESSION_TTL_SECONDS: "600",
    APP_ATTEST_ENV: "production",
    STOREKIT_ENV: "production",
    STOREKIT_ACCEPTED_ENVIRONMENTS: "Production,Sandbox",
    SESSION_JWT_SECRET: "a-secret-long-enough-for-tests",
    APPLE_APPATTEST_ROOT_CA: "root",
    APPLE_STOREKIT_ROOT_CA: "root",
    ...overrides,
  };
}

function transaction(environment, overrides = {}) {
  return {
    bundleId: "com.example.words",
    productId: "com.example.words.full",
    originalTransactionId: "2000000000000001",
    environment,
    ...overrides,
  };
}

test("production policy accepts exactly Apple's Production and TestFlight lanes", () => {
  assert.equal(contract.isProductionStoreKitPolicy("Production,Sandbox"), true);
  assert.equal(contract.isProductionStoreKitPolicy("Sandbox, Production"), true);
  assert.equal(contract.isProductionStoreKitPolicy("Production"), false);
  assert.equal(contract.isProductionStoreKitPolicy("Production,Sandbox,Xcode"), false);
  assert.equal(contract.isProductionStoreKitPolicy("Production,Sandbox,Future"), false);
});

test("Apple-signed Sandbox and Production grant distinct full entitlements", () => {
  const production = contract.validateTransactionClaims(env(), transaction("Production"));
  const sandbox = contract.validateTransactionClaims(env(), transaction("Sandbox"));
  assert.equal(production.scope, "full");
  assert.equal(production.storeKitEnvironment, "Production");
  assert.equal(sandbox.scope, "full");
  assert.equal(sandbox.storeKitEnvironment, "Sandbox");
  assert.notEqual(
    contract.storeKitRecordKey(production.storeKitEnvironment, production.originalTransactionId),
    contract.storeKitRecordKey(sandbox.storeKitEnvironment, sandbox.originalTransactionId),
  );
});

test("production rejects Xcode, missing, unknown and incomplete transaction identity", () => {
  assert.throws(
    () => contract.validateTransactionClaims(
      env(), transaction("Sandbox", { bundleId: "com.example.other" }),
    ),
    /bundleId mismatch/,
  );
  assert.throws(
    () => contract.validateTransactionClaims(env(), transaction("Xcode")),
    /not accepted/,
  );
  assert.throws(
    () => contract.validateTransactionClaims(env(), transaction(undefined)),
    /unknown/,
  );
  assert.throws(
    () => contract.validateTransactionClaims(env(), transaction("Future")),
    /unknown/,
  );
  assert.throws(
    () => contract.validateTransactionClaims(
      env(), transaction("Sandbox", { originalTransactionId: undefined }),
    ),
    /originalTransactionId/,
  );
  assert.equal(
    contract.validateTransactionClaims(
      env(), transaction("Sandbox", { productId: "com.example.words.wrong" }),
    ),
    null,
  );
});

test("record keys preserve legacy Production identity and namespace test records", () => {
  assert.equal(contract.storeKitRecordKey("Production", "123"), "123");
  assert.equal(contract.storeKitRecordKey("Sandbox", "123"), "sandbox:123");
  assert.equal(contract.storeKitRecordKey("Xcode", "123"), "xcode:123");
  assert.equal(contract.storeKitSubject("Production", "123"), "storekit:production:123");
  assert.equal(contract.storeKitSubject("Sandbox", "123"), "storekit:sandbox:123");
});

test("health gate makes loss or weakening of TestFlight policy deploy-blocking", () => {
  const healthy = contract.healthReport(env());
  assert.equal(healthy.status, "ok");
  assert.deepEqual(healthy.storeKitEnvironments, ["Production", "Sandbox"]);

  for (const policy of [undefined, "Production", "Production,Sandbox,Xcode", "Sandbox"]) {
    const report = contract.healthReport(env({
      STOREKIT_ACCEPTED_ENVIRONMENTS: policy,
    }));
    assert.equal(report.status, "misconfigured", String(policy));
    assert.ok(report.missing.includes(
      "STOREKIT_ACCEPTED_ENVIRONMENTS(Production,Sandbox)",
    ));
  }
});

test("session JWT preserves the verified lane and rejects invented lane claims", async () => {
  const issuer = contract.issuerFor("prod");
  const sandbox = await contract.signSession(
    "secret", issuer, "device", "storekit", "full", 600, 100, "Sandbox",
  );
  const sandboxClaims = await contract.verifySession(
    ["secret"], issuer, sandbox, 101,
  );
  assert.equal(sandboxClaims.sk_env, "Sandbox");

  const invented = await contract.signSession(
    "secret", issuer, "device", "storekit", "full", 600, 100, "Future",
  );
  assert.equal(
    await contract.verifySession(["secret"], issuer, invented, 101),
    null,
  );

  const environmentOnPromo = await contract.signSession(
    "secret", issuer, "promo:test", "promo", "full", 600, 100, "Sandbox",
  );
  assert.equal(
    await contract.verifySession(["secret"], issuer, environmentOnPromo, 101),
    null,
  );

  // Sessions minted immediately before this deployment did not contain sk_env.
  // Accept only their historical ten-minute shape; a longer-lived lane-less
  // StoreKit token must not gain indefinite compatibility.
  const legacy = await contract.signSession(
    "secret", issuer, "device", "storekit", "full", 600, 100,
  );
  assert.notEqual(
    await contract.verifySession(["secret"], issuer, legacy, 101),
    null,
  );
  const overlongLegacy = await contract.signSession(
    "secret", issuer, "device", "storekit", "full", 601, 100,
  );
  assert.equal(
    await contract.verifySession(["secret"], issuer, overlongLegacy, 101),
    null,
  );
});

test("snapshot grants cannot cross StoreKit lanes even for the same device", async () => {
  const base = {
    sub: "same-attested-device",
    ent: "storekit",
    scope: "full",
    iss: "gv-read-worker/prod",
    iat: 100,
    exp: 10_000,
  };
  const production = { ...base, sk_env: "Production" };
  const sandbox = { ...base, sk_env: "Sandbox" };
  const snapshot = "a".repeat(64);
  const grant = await contract.mintSnapshotGrant(
    "secret", sandbox, snapshot, "en", 200,
  );
  assert.equal(await contract.verifySnapshotGrant(
    ["secret"], grant, sandbox, snapshot, "en", 201,
  ), true);
  assert.equal(await contract.verifySnapshotGrant(
    ["secret"], grant, production, snapshot, "en", 201,
  ), false);
});
