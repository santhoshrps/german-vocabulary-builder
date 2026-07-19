import { utf8, bytesToB64Url, b64UrlToBytes, timingSafeEqualBytes } from "./bytes";

// Minimal HS256 JWT. The same worker signs and verifies, so a symmetric secret is fine.

// Issuer claim: stamped into every token and REQUIRED on verify. It carries the
// ENVIRONMENT identity (MS2-FR-29): "gv-read-worker/prod" vs "gv-read-worker/dev" —
// so a token minted by one environment is rejected by every other, even in the
// worst case of a shared or confused signing secret. Also rejects tokens signed by
// any other system that happens to share the secret.
export function issuerFor(envName: string): string {
  return `gv-read-worker/${envName}`;
}

export interface SessionClaims {
  sub: string;     // device_id (or "promo:<label>" for test sessions)
  ent: string;     // entitlement type: "storekit" | "promo"
  scope: string;   // access scope: "free" | "full"
  iss?: string;    // issuer (ISSUER) — optional in the type for decode, enforced on verify
  iat: number;
  exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signSession(
  secret: string,
  issuer: string,
  sub: string,
  ent: string,
  scope: string,
  ttlSeconds: number,
  now: number
): Promise<string> {
  const header = bytesToB64Url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const claims: SessionClaims = { sub, ent, scope, iss: issuer, iat: now, exp: now + ttlSeconds };
  const payload = bytesToB64Url(utf8(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(signingInput)));
  return `${signingInput}.${bytesToB64Url(sig)}`;
}

// Verifies against one or more accepted secrets — normally just the current one; during a
// key rotation the previous secret rides along for a grace window (MS2-FR-30e) so live
// sessions survive the rotation. Minting never uses the previous key.
export async function verifySession(
  secrets: readonly string[],
  issuer: string,
  token: string,
  now: number
): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;

  // Defense-in-depth: there is no alg-confusion path (the HMAC is always recomputed with
  // HS256 regardless of the header), but assert the header anyway so a token minted with any
  // other algorithm/type is rejected explicitly rather than incidentally.
  try {
    const h = JSON.parse(new TextDecoder().decode(b64UrlToBytes(header))) as { alg?: string; typ?: string };
    if (h.alg !== "HS256") return null;
    if (h.typ !== undefined && h.typ !== "JWT") return null;
  } catch {
    return null;
  }

  // M19: decode the signature INSIDE a guard — b64UrlToBytes → atob throws on malformed
  // input, and unguarded it 500s (not 401) on every authenticated route. A bad signature
  // segment is an invalid token, full stop.
  let provided: Uint8Array;
  try {
    provided = b64UrlToBytes(sig);
  } catch {
    return null;
  }
  let signatureValid = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const key = await hmacKey(secret);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(`${header}.${payload}`)));
    if (timingSafeEqualBytes(provided, expected)) {
      signatureValid = true;
      break;
    }
  }
  if (!signatureValid) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64UrlToBytes(payload)));
  } catch {
    return null;
  }
  if (claims.iss !== issuer) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  return claims;
}
