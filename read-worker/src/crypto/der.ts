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

// Value bytes of the App Attest nonce extension (1.2.840.113635.100.8.2).
// extnValue OCTET STRING wraps: SEQUENCE { [1] EXPLICIT OCTET STRING nonce }.
export function extractAppAttestNonce(certDer: Uint8Array): Uint8Array {
  const { tbs } = certParts(certDer);
  // tbs children: [version]? serial, sigAlg, issuer, validity, subject, spki, [3] extensions
  let extensions: TLV | null = null;
  for (const child of children(certDer, tbs)) {
    if (child.tag === 0xa3) {
      extensions = child;
      break;
    }
  }
  if (!extensions) throw new Error("der: no extensions");
  const extSeq = children(certDer, extensions)[0]; // SEQUENCE OF Extension
  for (const ext of children(certDer, extSeq)) {
    const parts = children(certDer, ext);
    const oid = parts.find((p) => p.tag === 0x06);
    if (!oid || oidHex(certDer, oid) !== OID_APPATTEST_NONCE) continue;
    const octet = parts.find((p) => p.tag === 0x04); // extnValue
    if (!octet) break;
    // Parse the inner DER: SEQUENCE { [1] { OCTET STRING nonce } }
    const innerSeq = readTLV(certDer, octet.contentStart);
    const tagged = children(certDer, innerSeq)[0]; // [1]
    const nonceOctet = children(certDer, tagged)[0]; // OCTET STRING
    return certDer.slice(nonceOctet.contentStart, nonceOctet.contentEnd);
  }
  throw new Error("der: App Attest nonce extension not found");
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

// Convert DER ECDSA signature (SEQUENCE { r INTEGER, s INTEGER }) to raw r||s
// (fixed 32-byte big-endian each) for WebCrypto P-256 verification.
export function ecdsaDerToRaw(der: Uint8Array): Uint8Array {
  const seq = readTLV(der, 0);
  const [r, s] = children(der, seq);
  const norm = (t: TLV): Uint8Array => {
    let bytes = der.slice(t.contentStart, t.contentEnd);
    // Strip a leading 0x00 sign byte, then left-pad to 32.
    while (bytes.length > 32 && bytes[0] === 0x00) bytes = bytes.slice(1);
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(norm(r), 0);
  raw.set(norm(s), 32);
  return raw;
}
