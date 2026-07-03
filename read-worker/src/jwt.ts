import { utf8, bytesToB64Url, b64UrlToBytes, timingSafeEqualBytes } from "./bytes";

// Minimal HS256 JWT. The same worker signs and verifies, so a symmetric secret is fine.

// Issuer claim: stamped into every token and REQUIRED on verify, so a token signed by any
// other system that happens to share the secret (or a future second service) can't be
// replayed against this worker.
const ISSUER = "gv-read-worker";

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
  sub: string,
  ent: string,
  scope: string,
  ttlSeconds: number,
  now: number
): Promise<string> {
  const header = bytesToB64Url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const claims: SessionClaims = { sub, ent, scope, iss: ISSUER, iat: now, exp: now + ttlSeconds };
  const payload = bytesToB64Url(utf8(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(signingInput)));
  return `${signingInput}.${bytesToB64Url(sig)}`;
}

export async function verifySession(
  secret: string,
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

  const key = await hmacKey(secret);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(`${header}.${payload}`)));
  const provided = b64UrlToBytes(sig);
  if (!timingSafeEqualBytes(provided, expected)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64UrlToBytes(payload)));
  } catch {
    return null;
  }
  if (claims.iss !== ISSUER) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  return claims;
}
