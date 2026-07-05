// Apple App Attest verification.
//
// IMPORTANT: This implements Apple's documented algorithm (see "Validating Apps
// That Connect to Your Server"). Hand-rolled X.509/CBOR crypto MUST be validated
// against Apple's published test vectors before you trust it in production, and
// you should pin the real Apple App Attest Root CA via APPLE_APPATTEST_ROOT_CA.
//
// Two operations:
//   verifyAttestation — one-time device registration; returns the device public key.
//   verifyAssertion   — per-request proof the genuine app still holds that key.

import { Env } from "./env";
import {
  utf8, sha256, concat, b64ToBytes, bytesToB64, bytesToB64Url, timingSafeEqualBytes,
} from "./bytes";
import { decodeCbor } from "./crypto/cbor";
import { extractSPKI, extractECPublicKeyPoint, extractAppAttestNonce, ecdsaDerToRaw } from "./crypto/der";
import { verifyChainToAppleRoot } from "./crypto/x509";

const AAGUID_PROD = utf8("appattest\0\0\0\0\0\0\0"); // 16 bytes
const AAGUID_DEV = utf8("appattestdevelop");        // 16 bytes

/// Whether this deployment requires App Attest (a genuine, registered device) for
/// EVERY session — including the free tier — and enforces the search reveal cap.
/// True in production; false on the dev worker (APP_ATTEST_ENV="development"), which
/// DEBUG iOS builds target, so local testing needs no attestation and has no cap.
export function attestationRequired(env: Env): boolean {
  return env.APP_ATTEST_ENV === "production";
}

async function importP256Spki(spki: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    spki,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

async function appIdHash(env: Env): Promise<Uint8Array> {
  return sha256(utf8(`${env.APP_TEAM_ID}.${env.APP_BUNDLE_ID}`));
}

// authenticatorData layout: rpIdHash(32) | flags(1) | signCount(4) | [attestedCredentialData...]
// attestedCredentialData: aaguid(16) | credIdLen(2) | credId(credIdLen) | credPubKey(COSE)
function parseAuthData(authData: Uint8Array) {
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount =
    (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];
  let credentialId: Uint8Array | null = null;
  let aaguid: Uint8Array | null = null;
  if (authData.length >= 55) {
    aaguid = authData.slice(37, 53);
    const credIdLen = (authData[53] << 8) | authData[54];
    credentialId = authData.slice(55, 55 + credIdLen);
  }
  return { rpIdHash, flags, signCount: signCount >>> 0, aaguid, credentialId };
}

export interface AttestationResult {
  deviceId: string;     // base64url keyId
  publicKeySpki: string; // base64 SPKI DER
  signCount: number;
}

export async function verifyAttestation(
  env: Env,
  keyIdB64: string,
  attestationObjectB64: string,
  challenge: string
): Promise<AttestationResult> {
  const obj = decodeCbor(b64ToBytes(attestationObjectB64)) as Map<string, unknown>;
  const fmt = obj.get("fmt");
  if (fmt !== "apple-appattest") throw new Error("attest: bad fmt");

  const attStmt = obj.get("attStmt") as Map<string, unknown>;
  const authData = obj.get("authData") as Uint8Array;
  const x5c = attStmt.get("x5c") as Uint8Array[];
  if (!x5c || x5c.length < 2) throw new Error("attest: missing x5c chain");

  const credCert = x5c[0];

  // 1. nonce = SHA256(authData || SHA256(challenge)); must match the cert extension.
  const clientDataHash = await sha256(utf8(challenge));
  const expectedNonce = await sha256(concat(authData, clientDataHash));
  const certNonce = extractAppAttestNonce(credCert);
  if (!timingSafeEqualBytes(expectedNonce, certNonce)) throw new Error("attest: nonce mismatch");

  // 2. Verify the cert chain up to the pinned Apple App Attest Root CA (shared x509.ts:
  //    per-cert curve/hash detection, validity windows, CA basicConstraints).
  await verifyChainToAppleRoot(x5c, env.APPLE_APPATTEST_ROOT_CA, "attest");

  // 3. Public key from the leaf cert: the full SPKI (stored + used later to verify assertions) and
  //    the raw uncompressed EC point (what Apple hashes to form the keyId — see step 6).
  const spki = extractSPKI(credCert);
  const publicKeyPoint = extractECPublicKeyPoint(credCert);

  // 4. rpIdHash must equal SHA256(teamId.bundleId).
  const { rpIdHash, aaguid, credentialId, signCount } = parseAuthData(authData);
  const wantApp = await appIdHash(env);
  if (!timingSafeEqualBytes(rpIdHash, wantApp)) throw new Error("attest: appId mismatch");

  // 5. aaguid must match the configured App Attest environment.
  const wantAaguid = env.APP_ATTEST_ENV === "development" ? AAGUID_DEV : AAGUID_PROD;
  if (!aaguid || !timingSafeEqualBytes(aaguid, wantAaguid)) throw new Error("attest: aaguid mismatch");

  // 5b. Apple's algorithm requires the counter to be 0 at attestation. A freshly generated key
  //     is always 0; a non-zero value means the key was already used (or crafted authData), i.e.
  //     not a clean first registration — reject it so the stored baseline can't start mid-stream.
  if (signCount !== 0) throw new Error("attest: nonzero sign count");

  // 6. keyId = SHA256(uncompressed EC public-key point) — Apple hashes the X9.62 point, NOT the full
  //    SPKI. Must equal credentialId in authData AND the client-supplied keyId.
  const pubKeyHash = await sha256(publicKeyPoint);
  const keyIdFromHash = bytesToB64Url(pubKeyHash);
  if (!credentialId || !timingSafeEqualBytes(pubKeyHash, credentialId)) {
    throw new Error("attest: credentialId mismatch");
  }
  if (keyIdFromHash !== keyIdB64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")) {
    throw new Error("attest: keyId mismatch");
  }

  return { deviceId: keyIdFromHash, publicKeySpki: bytesToB64(spki), signCount };
}

export interface AssertionInput {
  deviceId: string;
  publicKeySpki: string; // stored base64 SPKI
  storedSignCount: number;
  assertionB64: string;
  challenge: string;
}

export interface AssertionResult {
  newSignCount: number;
}

// Assertion (CBOR): { signature: bytes (DER ECDSA), authenticatorData: bytes }
// Signed message = SHA256(authenticatorData || SHA256(challenge)).
export async function verifyAssertion(env: Env, input: AssertionInput): Promise<AssertionResult> {
  const obj = decodeCbor(b64ToBytes(input.assertionB64)) as Map<string, unknown>;
  const signature = obj.get("signature") as Uint8Array;
  const authData = obj.get("authenticatorData") as Uint8Array;
  if (!signature || !authData) throw new Error("assert: malformed");

  const clientDataHash = await sha256(utf8(input.challenge));
  const message = concat(authData, clientDataHash);

  const key = await importP256Spki(b64ToBytes(input.publicKeySpki));
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    ecdsaDerToRaw(signature),
    message
  );
  if (!ok) throw new Error("assert: bad signature");

  // rpIdHash + monotonic counter (clone/replay defense).
  const { rpIdHash, signCount } = parseAuthData(authData);
  const wantApp = await appIdHash(env);
  if (!timingSafeEqualBytes(rpIdHash, wantApp)) throw new Error("assert: appId mismatch");
  if (signCount <= input.storedSignCount) throw new Error("assert: counter not increasing");

  return { newSignCount: signCount };
}
