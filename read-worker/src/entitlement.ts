// Entitlement verification: two independent ways to prove "this device may read".
//
//   1. StoreKit 2 — a JWS signed transaction from the App Store, verified against
//      the leaf cert's key and pinned to Apple Root CA - G3. The production path.
//   2. Promo code — a shared secret checked against the promo_codes table. The
//      self-test path so you can exercise the API now, before the iOS app exists.
//
// As with App Attest, validate the StoreKit JWS path against Apple sample data
// before trusting it in production, and set APPLE_STOREKIT_ROOT_CA.

import { Env } from "./env";
import { utf8, sha256, bytesToHex, b64UrlToBytes, b64ToBytes } from "./bytes";
import { extractSPKI } from "./crypto/der";
import { verifyChainToAppleRoot } from "./crypto/x509";

/// Access scope an entitlement grants. "free" = the curated 100-word preview
/// (rows with free = 1); "full" = the entire dataset.
export type Scope = "free" | "full";

export interface Entitlement {
  type: "storekit" | "promo";
  scope: Scope; // how much of the dataset this entitlement unlocks
  label: string; // productId or promo label, for the JWT subject/audit
  /// StoreKit only: the purchase's stable identity, used to cap how many distinct
  /// devices one signed transaction can mint sessions for (Apple-ID sharing bound).
  originalTransactionId?: string;
  /// Promo only: sha256(code) hex — the key for per-code device claims (UA-FR-4b).
  codeHash?: string;
}

// ---- Promo code -------------------------------------------------------------

export async function verifyPromoCode(env: Env, code: string): Promise<Entitlement | null> {
  if (!code) return null;
  const hash = bytesToHex(await sha256(utf8(code)));
  const row = await env.DB.prepare(
    "SELECT label, tier, active, expires_at FROM promo_codes WHERE code_hash = ?"
  ).bind(hash).first<{ label: string | null; tier: string | null; active: number; expires_at: string | null }>();

  if (!row || !row.active) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  // Anything other than an explicit "full" tier is treated as free (least privilege).
  const scope: Scope = row.tier === "full" ? "full" : "free";
  return { type: "promo", scope, label: row.label || "promo", codeHash: hash };
}

// ---- Promo device claims (UA-FR-4b: personal full-access codes) --------------

/// How many distinct attested devices one full-tier promo code may bind to. Two, not one:
/// a reinstall regenerates the App Attest key, so a cap of 1 would lock the legitimate
/// owner out of their own code on every reinstall or phone upgrade (and iPhone+iPad is a
/// normal single-owner pair). Casual code-forwarding still dies at device 3.
export const PROMO_DEVICE_CAP = 2;

export type PromoClaimResult = "ok" | "code-in-use" | "device-check-required";

/// Binds a full-tier promo code to the attested devices that use it (promo_claims table).
///
/// Attested mint: the device keeps its existing claim, takes a free slot, or — when the
/// code is already bound to PROMO_DEVICE_CAP other devices — is rejected ("code-in-use").
///
/// Unattested mint (App Attest throttled/unavailable): STRICT at first use, tolerant
/// after. A code with zero claims never mints without a proven device ("device-check-
/// required", transient, retryable) — that is the whole binding guarantee. A code that
/// already has a claim may re-mint unattested, because this is almost always the claimant
/// whose attestation Apple is momentarily throttling, and bricking them would repeat the
/// 2026-07-12 words-download failure (UA-FR-4c). A patched client that never attests can
/// ride that lenience — accepted: it can't be bound by attestation at all, and the code
/// stays individually revocable.
export async function claimPromoDevice(
  env: Env, codeHash: string, deviceId: string | null
): Promise<PromoClaimResult> {
  if (!deviceId) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM promo_claims WHERE code_hash = ?"
    ).bind(codeHash).first<{ n: number }>();
    return (row?.n ?? 0) > 0 ? "ok" : "device-check-required";
  }
  // Single atomic statement: claim a slot only while one is free; re-claiming one's own
  // slot is a no-op. D1 serializes writes, so two new devices racing for the last slot
  // can't both get in (the second one's count subquery already sees the cap reached).
  await env.DB.prepare(
    `INSERT INTO promo_claims (code_hash, device_id)
     SELECT ?1, ?2
     WHERE (SELECT COUNT(*) FROM promo_claims WHERE code_hash = ?1) < ?3
     ON CONFLICT (code_hash, device_id) DO NOTHING`
  ).bind(codeHash, deviceId, PROMO_DEVICE_CAP).run();
  const mine = await env.DB.prepare(
    "SELECT 1 FROM promo_claims WHERE code_hash = ?1 AND device_id = ?2"
  ).bind(codeHash, deviceId).first();
  return mine ? "ok" : "code-in-use";
}

// ---- StoreKit 2 signed transaction (JWS) ------------------------------------

interface JwsHeader {
  alg: string;
  x5c: string[]; // [leaf, intermediate, root] base64 DER
}

interface TransactionPayload {
  bundleId: string;
  productId: string;
  originalTransactionId?: string; // stable purchase identity (device-cap binding)
  expiresDate?: number;     // ms epoch (subscriptions)
  revocationDate?: number;  // ms epoch
}

/// Whether StoreKit "xcode" test mode is active for this deployment.
///
/// "xcode" mode trusts locally-signed StoreKit Configuration File transactions
/// WITHOUT Apple signature/chain verification, and lets the /v1/session and
/// /v1/snapshot paths skip App Attest entirely. It exists ONLY for local Xcode
/// testing and must never be honored on a production deployment.
///
/// To make that structurally impossible (not just a config convention), xcode
/// mode is hard-coupled to the App Attest environment: it is honored only when
/// App Attest is also in "development". A deployment with APP_ATTEST_ENV set to
/// "production" therefore refuses to trust unsigned transactions even if
/// STOREKIT_ENV is misconfigured to "xcode" — it fails closed onto the real
/// Apple-verified path. This is the single choke point for the whole dev path
/// (used by verifyStoreKitTransaction, the /v1/session mint, and the snapshot
/// assertion gate).
export function storeKitXcodeMode(env: Env): boolean {
  if (env.STOREKIT_ENV !== "xcode") return false;
  if (env.APP_ATTEST_ENV === "production") {
    console.error(
      'SECURITY: ignoring STOREKIT_ENV="xcode" because APP_ATTEST_ENV="production". ' +
        "Refusing to trust unsigned StoreKit transactions on a production deployment. " +
        "Use `wrangler deploy --env dev` (App Attest development) for Xcode testing."
    );
    return false;
  }
  return true;
}

export async function verifyStoreKitTransaction(
  env: Env,
  signedTransaction: string
): Promise<Entitlement | null> {
  const parts = signedTransaction.split(".");
  if (parts.length !== 3) throw new Error("storekit: malformed JWS");
  const [headerB64, payloadB64, sigB64] = parts;

  // ---- Local Xcode testing path -------------------------------------------
  // StoreKit Configuration File transactions are signed by Xcode's local test
  // certificate, not Apple's CA, so they can't be verified against the Apple
  // root. In "xcode" mode we DECODE the payload and validate its claims only —
  // no signature/chain check. This is insecure by design and MUST be off
  // ("production") for any real build.
  if (storeKitXcodeMode(env)) {
    const payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(payloadB64))) as TransactionPayload;
    return validateTransactionClaims(env, payload);
  }

  const header = JSON.parse(new TextDecoder().decode(b64UrlToBytes(headerB64))) as JwsHeader;
  if (header.alg !== "ES256" || !header.x5c?.length) throw new Error("storekit: bad header");

  // x5c certs are standard base64 DER.
  const chain = header.x5c.map((c) => b64ToBytes(c));

  // 1. Verify the chain terminates at the pinned Apple Root CA - G3 (shared x509.ts:
  //    per-cert curve/hash detection, validity windows, CA basicConstraints).
  await verifyChainToAppleRoot(chain, env.APPLE_STOREKIT_ROOT_CA, "storekit");

  // 2. Verify the JWS signature with the leaf cert's public key (ES256 = raw r||s).
  const leafKey = await crypto.subtle.importKey(
    "spki",
    extractSPKI(chain[0]),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    leafKey,
    b64UrlToBytes(sigB64),
    utf8(`${headerB64}.${payloadB64}`)
  );
  if (!ok) throw new Error("storekit: bad signature");

  // 3. Validate the payload claims.
  const payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(payloadB64))) as TransactionPayload;
  return validateTransactionClaims(env, payload);
}

// Shared claim checks: bundle id, allowed product, not expired/revoked. A valid
// StoreKit purchase always grants full access.
function validateTransactionClaims(env: Env, payload: TransactionPayload): Entitlement | null {
  if (payload.bundleId !== env.APP_BUNDLE_ID) throw new Error("storekit: bundleId mismatch");

  const allowed = env.ENTITLEMENT_PRODUCT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(payload.productId)) return null;

  const now = Date.now();
  if (payload.revocationDate && payload.revocationDate <= now) return null;
  if (payload.expiresDate && payload.expiresDate <= now) return null;

  return {
    type: "storekit",
    scope: "full",
    label: payload.productId,
    originalTransactionId: payload.originalTransactionId,
  };
}

