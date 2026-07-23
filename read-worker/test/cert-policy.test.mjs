// SEC-001 negative-proof suite (owner ruling 2026-07-23: synthetic Apple-SHAPED chains
// close the row's test obligation). Proves verifyChainToAppleRoot under the StoreKit
// purpose policy REJECTS every structurally valid chain whose certificates lack the right
// purpose markers or shape — and still ACCEPTS the correctly marked chain, so the policy
// can't silently lock out real transactions.
//
// Run: npm run test:certs   (compiles src/crypto via tsc, regenerates fixtures if absent)

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesPath = join(root, "test/fixtures/cert-chains.json");
if (!existsSync(fixturesPath)) {
  execSync("bash scripts/gen-cert-fixtures.sh", { cwd: root, stdio: "inherit" });
}
execSync("npx tsc -p test/tsconfig.certs.json", { cwd: root, stdio: "inherit" });

const { verifyChainToAppleRoot } = await import(join(root, ".test-dist/crypto/x509.js"));
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
const der = (name) => new Uint8Array(Buffer.from(fixtures[name], "base64"));

// Mirrors STOREKIT_CHAIN_PURPOSE in src/entitlement.ts (hex-encoded OID content bytes).
const PURPOSE = {
  leafMarkerOID: "2a864886f76364060b01",         // 1.2.840.113635.100.6.11.1
  intermediateMarkerOID: "2a864886f76364060201", // 1.2.840.113635.100.6.2.1
};

let failures = 0;
async function expectRejected(label, x5c, purpose = PURPOSE) {
  try {
    await verifyChainToAppleRoot(x5c, fixtures.root, label, purpose);
    console.error(`✘ ${label}: ACCEPTED a chain that must be rejected`);
    failures += 1;
  } catch (e) {
    console.log(`✔ ${label}: rejected (${e.message})`);
  }
}
async function expectAccepted(label, x5c, purpose = PURPOSE) {
  try {
    await verifyChainToAppleRoot(x5c, fixtures.root, label, purpose);
    console.log(`✔ ${label}: accepted`);
  } catch (e) {
    console.error(`✘ ${label}: REJECTED the valid chain (${e.message})`);
    failures += 1;
  }
}

const goodChain = [der("leaf-good"), der("inter-good"), der("root")];

// The policy accepts exactly the correctly marked, correctly shaped chain…
await expectAccepted("marked leaf under marked intermediate", goodChain);
// …and without a purpose policy the pure chain-of-trust check still passes (App Attest path).
await expectAccepted("no-policy chain-of-trust", [der("leaf-nomarker"), der("inter-good"), der("root")], null);

// Wrong PURPOSE, valid issuance — the exact SEC-001 attack class:
await expectRejected("leaf without any marker", [der("leaf-nomarker"), der("inter-good"), der("root")]);
await expectRejected("leaf with a DIFFERENT Apple-shaped marker", [der("leaf-wrongmarker"), der("inter-good"), der("root")]);
await expectRejected("marked leaf under an UNMARKED intermediate", [der("leaf-underbad"), der("inter-bad"), der("root")]);

// Wrong SHAPE:
await expectRejected("2-cert chain", [der("leaf-good"), der("inter-good")]);
await expectRejected("4-cert chain", [der("leaf-good"), der("inter-good"), der("root"), der("root")]);

// Broken issuance is still caught underneath the purpose layer (defense stays layered):
// no policy, so the rejection MUST come from the signature check itself.
await expectRejected("marked leaf presented under the WRONG intermediate signature",
  [der("leaf-good"), der("inter-bad"), der("root")], null);

if (failures > 0) {
  console.error(`${failures} cert-policy case(s) FAILED`);
  process.exit(1);
}
console.log("cert-policy: all cases passed");
