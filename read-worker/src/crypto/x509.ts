// Shared X.509 chain verification to a pinned Apple root — the ONE implementation used by
// both App Attest (appattest.ts) and StoreKit JWS (entitlement.ts) verification, so the
// trust rules can never drift between the two.
//
// Per link, everything is read from the certificates themselves instead of assumed:
//   - the verifying curve comes from the PARENT's SubjectPublicKeyInfo (Apple's roots —
//     Apple Root CA - G3 and the App Attest Root CA — are P-384; leaves are P-256, so a
//     hardcoded P-256 import can never verify a root-signed link);
//   - the hash comes from the CHILD's signatureAlgorithm OID (SHA-384 for root-signed
//     links, SHA-256 for leaf links);
//   - the raw r||s signature width follows the parent's curve.
// Additionally every cert must be inside its validity window, and every signer must be a
// CA per basicConstraints — so an expired chain or a leaf-signed cert fails closed.

import {
  extractSPKI, tbsBytes, signatureDer, ecdsaDerToRaw,
  spkiNamedCurve, signatureHash, validity, isCA, hasExtension, CURVE_COMPONENT_SIZE,
} from "./der";
import { b64ToBytes } from "../bytes";

/// Certificate-purpose policy (audit SEC-001): the Apple marker extensions that pin a chain
/// to its intended class. Without this, ANY Apple-rooted EC chain of the right shape could
/// sign attacker-selected claims — chain-of-trust alone proves issuance, not purpose.
/// (App Attest binds purpose differently: its distinct pinned root plus the required nonce
/// extension — 1.2.840.113635.100.8.2 — that `extractAppAttestNonce` fails closed on.)
export interface ChainPurposePolicy {
  /// Marker extension OID (hex content bytes) REQUIRED on the leaf certificate.
  leafMarkerOID: string;
  /// Marker extension OID (hex content bytes) REQUIRED on the intermediate CA.
  intermediateMarkerOID: string;
}

export async function verifyChainToAppleRoot(
  x5c: Uint8Array[],
  rootB64: string | undefined,
  label: string,
  purpose?: ChainPurposePolicy
): Promise<void> {
  if (!rootB64) throw new Error(`${label}: pinned Apple root CA not configured`);
  const now = Date.now();

  // Certificate purpose (audit SEC-001): enforced BEFORE any signature work. Under a purpose
  // policy the sender's chain must be exactly [leaf, intermediate, root] (Apple's published
  // shape — a longer or shorter chain is not a StoreKit signing chain), the leaf must carry
  // the class marker, and the intermediate must carry the Apple-intermediate marker.
  if (purpose) {
    if (x5c.length !== 3) throw new Error(`${label}: expected a 3-cert chain, got ${x5c.length}`);
    if (!hasExtension(x5c[0], purpose.leafMarkerOID)) {
      throw new Error(`${label}: leaf certificate lacks the required purpose marker`);
    }
    if (!hasExtension(x5c[1], purpose.intermediateMarkerOID)) {
      throw new Error(`${label}: intermediate certificate lacks the required purpose marker`);
    }
  }

  // Build the full chain: leaf, intermediate(s), then the pinned root as the trust anchor.
  // (If the sender already included the root, the final link is the root's self-signature
  // verified against the pinned copy — still anchored to our pin, not the sender's bytes.)
  const chain = [...x5c, b64ToBytes(rootB64)];

  for (const [i, cert] of chain.entries()) {
    const window = validity(cert);
    if (now < window.notBefore || now > window.notAfter) {
      throw new Error(`${label}: cert ${i} outside its validity window`);
    }
  }

  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (!isCA(parent)) throw new Error(`${label}: signer cert ${i + 1} is not a CA`);

    const parentSpki = extractSPKI(parent);
    const curve = spkiNamedCurve(parentSpki);
    const parentKey = await crypto.subtle.importKey(
      "spki",
      parentSpki,
      { name: "ECDSA", namedCurve: curve },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: signatureHash(child) },
      parentKey,
      ecdsaDerToRaw(signatureDer(child), CURVE_COMPONENT_SIZE[curve]),
      tbsBytes(child)
    );
    if (!ok) throw new Error(`${label}: chain link ${i} failed`);
  }
}
