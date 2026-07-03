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
  spkiNamedCurve, signatureHash, validity, isCA, CURVE_COMPONENT_SIZE,
} from "./der";
import { b64ToBytes } from "../bytes";

export async function verifyChainToAppleRoot(
  x5c: Uint8Array[],
  rootB64: string | undefined,
  label: string
): Promise<void> {
  if (!rootB64) throw new Error(`${label}: pinned Apple root CA not configured`);
  const now = Date.now();

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
