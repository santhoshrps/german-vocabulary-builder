// Minimal DER / ASN.1 reader with just enough to verify Apple X.509 certs:
//   - walk TLV structures
//   - extract the SubjectPublicKeyInfo (for WebCrypto 'spki' import)
//   - read a specific extension's value by OID (App Attest nonce)
//   - pull out tbsCertificate + signature for chain verification
//   - convert a DER ECDSA signature to the raw r||s form WebCrypto expects

export interface TLV {
  tag: number;
  headerLen: number;
  contentStart: number;
  contentEnd: number; // exclusive
}

export function readTLV(buf: Uint8Array, offset: number): TLV {
  const tag = buf[offset];
  let p = offset + 1;
  let len = buf[p];
  p += 1;
  if (len & 0x80) {
    const numBytes = len & 0x7f;
    len = 0;
    for (let i = 0; i < numBytes; i++) len = (len << 8) | buf[p++];
  }
  return { tag, headerLen: p - offset, contentStart: p, contentEnd: p + len };
}

// Full DER element (tag+len+content) as a byte slice.
export function element(buf: Uint8Array, tlv: TLV): Uint8Array {
  return buf.slice(tlv.contentStart - tlv.headerLen, tlv.contentEnd);
}

// Ordered children of a constructed element (SEQUENCE / SET / context-tagged).
export function children(buf: Uint8Array, parent: TLV): TLV[] {
  const out: TLV[] = [];
  let p = parent.contentStart;
  while (p < parent.contentEnd) {
    const t = readTLV(buf, p);
    out.push(t);
    p = t.contentEnd;
  }
  return out;
}

const OID_EC_PUBLIC_KEY = "2a8648ce3d0201"; // 1.2.840.10045.2.1
const OID_APPATTEST_NONCE = "2a864886f763640802"; // 1.2.840.113635.100.8.2
const OID_BASIC_CONSTRAINTS = "551d13"; // 2.5.29.19

// EC named curves (AlgorithmIdentifier parameters). Apple's device/leaf keys are P-256,
// but the Apple App Attest Root CA and Apple Root CA - G3 are P-384 — the curve MUST be
// read from each cert, never assumed.
const OID_CURVE_P256 = "2a8648ce3d030107"; // 1.2.840.10045.3.1.7 (prime256v1)
const OID_CURVE_P384 = "2b81040022"; // 1.3.132.0.34 (secp384r1)
const OID_CURVE_P521 = "2b81040023"; // 1.3.132.0.35 (secp521r1)

// ecdsa-with-SHA2 signature algorithms (certificate signatureAlgorithm).
const OID_ECDSA_SHA256 = "2a8648ce3d040302"; // 1.2.840.10045.4.3.2
const OID_ECDSA_SHA384 = "2a8648ce3d040303"; // 1.2.840.10045.4.3.3
const OID_ECDSA_SHA512 = "2a8648ce3d040304"; // 1.2.840.10045.4.3.4

export type NamedCurve = "P-256" | "P-384" | "P-521";
export type HashName = "SHA-256" | "SHA-384" | "SHA-512";

/// ECDSA signature component size (bytes) per curve — the raw r||s width WebCrypto expects.
export const CURVE_COMPONENT_SIZE: Record<NamedCurve, number> = {
  "P-256": 32,
  "P-384": 48,
  "P-521": 66,
};

function oidHex(buf: Uint8Array, tlv: TLV): string {
  let s = "";
  for (let i = tlv.contentStart; i < tlv.contentEnd; i++) s += buf[i].toString(16).padStart(2, "0");
  return s;
}

// X.509 Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
function certParts(buf: Uint8Array): { tbs: TLV; sigAlg: TLV; sigVal: TLV; cert: TLV } {
  const cert = readTLV(buf, 0);
  const [tbs, sigAlg, sigVal] = children(buf, cert);
  return { tbs, sigAlg, sigVal, cert };
}

// SubjectPublicKeyInfo DER (suitable for crypto.subtle.importKey('spki', ...)).
export function extractSPKI(certDer: Uint8Array): Uint8Array {
  const { tbs } = certParts(certDer);
  for (const child of children(certDer, tbs)) {
    if (child.tag !== 0x30) continue; // SEQUENCE
    const inner = children(certDer, child);
    // SPKI = SEQUENCE { AlgorithmIdentifier SEQUENCE { OID ecPublicKey, ... }, BIT STRING }
    if (inner.length >= 2 && inner[0].tag === 0x30 && inner[1].tag === 0x03) {
      const algId = children(certDer, inner[0]);
      if (algId.length && algId[0].tag === 0x06 && oidHex(certDer, algId[0]) === OID_EC_PUBLIC_KEY) {
        return element(certDer, child);
      }
    }
  }
  throw new Error("der: SubjectPublicKeyInfo not found");
}

// An extension's extnValue OCTET STRING by OID, or null when the cert doesn't carry it
// (or has no extensions at all). Shared by the App Attest nonce and basicConstraints reads.
function findExtension(certDer: Uint8Array, wantOidHex: string): TLV | null {
  const { tbs } = certParts(certDer);
  // tbs children: [version]? serial, sigAlg, issuer, validity, subject, spki, [3] extensions
  let extensions: TLV | null = null;
  for (const child of children(certDer, tbs)) {
    if (child.tag === 0xa3) {
      extensions = child;
      break;
    }
  }
  if (!extensions) return null;
  const extSeq = children(certDer, extensions)[0]; // SEQUENCE OF Extension
  for (const ext of children(certDer, extSeq)) {
    const parts = children(certDer, ext);
    const oid = parts.find((p) => p.tag === 0x06);
    if (!oid || oidHex(certDer, oid) !== wantOidHex) continue;
    const octet = parts.find((p) => p.tag === 0x04); // extnValue (skips the critical BOOLEAN)
    return octet ?? null;
  }
  return null;
}

// Value bytes of the App Attest nonce extension (1.2.840.113635.100.8.2).
// extnValue OCTET STRING wraps: SEQUENCE { [1] EXPLICIT OCTET STRING nonce }.
export function extractAppAttestNonce(certDer: Uint8Array): Uint8Array {
  const octet = findExtension(certDer, OID_APPATTEST_NONCE);
  if (!octet) throw new Error("der: App Attest nonce extension not found");
  // Parse the inner DER: SEQUENCE { [1] { OCTET STRING nonce } }
  const innerSeq = readTLV(certDer, octet.contentStart);
  const tagged = children(certDer, innerSeq)[0]; // [1]
  const nonceOctet = children(certDer, tagged)[0]; // OCTET STRING
  return certDer.slice(nonceOctet.contentStart, nonceOctet.contentEnd);
}

// Whether the cert is a CA per basicConstraints (2.5.29.19):
// extnValue wraps SEQUENCE { cA BOOLEAN DEFAULT FALSE, pathLenConstraint INTEGER OPTIONAL }.
// No extension / empty SEQUENCE both mean cA = FALSE.
export function isCA(certDer: Uint8Array): boolean {
  const octet = findExtension(certDer, OID_BASIC_CONSTRAINTS);
  if (!octet) return false;
  const seq = readTLV(certDer, octet.contentStart);
  const kids = children(certDer, seq);
  return kids.length > 0 && kids[0].tag === 0x01 && certDer[kids[0].contentStart] !== 0x00;
}

// The named curve of an EC SubjectPublicKeyInfo:
// SPKI = SEQUENCE { AlgorithmIdentifier SEQUENCE { OID ecPublicKey, OID namedCurve }, BIT STRING }.
export function spkiNamedCurve(spki: Uint8Array): NamedCurve {
  const seq = readTLV(spki, 0);
  const [algId] = children(spki, seq);
  if (!algId || algId.tag !== 0x30) throw new Error("der: malformed SPKI");
  const params = children(spki, algId);
  if (params.length < 2 || params[1].tag !== 0x06) throw new Error("der: EC named curve missing");
  switch (oidHex(spki, params[1])) {
    case OID_CURVE_P256: return "P-256";
    case OID_CURVE_P384: return "P-384";
    case OID_CURVE_P521: return "P-521";
    default: throw new Error("der: unsupported EC curve");
  }
}

// The hash of a certificate's outer signatureAlgorithm (ecdsa-with-SHA2 family only).
export function signatureHash(certDer: Uint8Array): HashName {
  const { sigAlg } = certParts(certDer);
  const oid = children(certDer, sigAlg).find((t) => t.tag === 0x06);
  if (!oid) throw new Error("der: signatureAlgorithm OID missing");
  switch (oidHex(certDer, oid)) {
    case OID_ECDSA_SHA256: return "SHA-256";
    case OID_ECDSA_SHA384: return "SHA-384";
    case OID_ECDSA_SHA512: return "SHA-512";
    default: throw new Error("der: unsupported signature algorithm");
  }
}

// Validity ::= SEQUENCE { notBefore Time, notAfter Time } — the first tbs child that is a
// SEQUENCE of exactly two UTCTime/GeneralizedTime values (serial/sigAlg/issuer can't match).
// Returned as ms epochs for a direct Date.now() comparison.
export function validity(certDer: Uint8Array): { notBefore: number; notAfter: number } {
  const { tbs } = certParts(certDer);
  for (const child of children(certDer, tbs)) {
    if (child.tag !== 0x30) continue;
    const kids = children(certDer, child);
    if (kids.length === 2 && kids.every((k) => k.tag === 0x17 || k.tag === 0x18)) {
      return { notBefore: parseTime(certDer, kids[0]), notAfter: parseTime(certDer, kids[1]) };
    }
  }
  throw new Error("der: validity not found");
}

// UTCTime (YYMMDDHHMMSSZ, RFC 5280: YY < 50 → 20YY) or GeneralizedTime (YYYYMMDDHHMMSSZ) → ms epoch.
function parseTime(buf: Uint8Array, tlv: TLV): number {
  let s = "";
  for (let i = tlv.contentStart; i < tlv.contentEnd; i++) s += String.fromCharCode(buf[i]);
  const generalized = tlv.tag === 0x18;
  const match = generalized
    ? s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/)
    : s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) throw new Error("der: malformed time");
  const year = generalized ? parseInt(match[1], 10)
    : parseInt(match[1], 10) < 50 ? 2000 + parseInt(match[1], 10) : 1900 + parseInt(match[1], 10);
  return Date.UTC(
    year, parseInt(match[2], 10) - 1, parseInt(match[3], 10),
    parseInt(match[4], 10), parseInt(match[5], 10), parseInt(match[6], 10)
  );
}

// tbsCertificate bytes (the signed message) for chain verification.
export function tbsBytes(certDer: Uint8Array): Uint8Array {
  const { tbs } = certParts(certDer);
  return element(certDer, tbs);
}

// signatureValue BIT STRING contents (DER ECDSA-Sig-Value).
export function signatureDer(certDer: Uint8Array): Uint8Array {
  const { sigVal } = certParts(certDer);
  // BIT STRING: first content byte is the count of unused bits (0 here).
  return certDer.slice(sigVal.contentStart + 1, sigVal.contentEnd);
}

// Convert DER ECDSA signature (SEQUENCE { r INTEGER, s INTEGER }) to the raw r||s form
// WebCrypto expects — fixed big-endian components sized to the signing key's curve
// (32 for P-256, 48 for P-384, 66 for P-521; see CURVE_COMPONENT_SIZE).
export function ecdsaDerToRaw(der: Uint8Array, componentSize = 32): Uint8Array {
  const seq = readTLV(der, 0);
  const [r, s] = children(der, seq);
  const norm = (t: TLV): Uint8Array => {
    let bytes = der.slice(t.contentStart, t.contentEnd);
    // Strip leading 0x00 sign bytes, then left-pad to the component size.
    while (bytes.length > componentSize && bytes[0] === 0x00) bytes = bytes.slice(1);
    if (bytes.length > componentSize) throw new Error("der: ECDSA component exceeds curve size");
    const out = new Uint8Array(componentSize);
    out.set(bytes, componentSize - bytes.length);
    return out;
  };
  const raw = new Uint8Array(componentSize * 2);
  raw.set(norm(r), 0);
  raw.set(norm(s), componentSize);
  return raw;
}
