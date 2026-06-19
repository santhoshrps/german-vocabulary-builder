import { utf8, bytesToB64Url, b64UrlToBytes, timingSafeEqualBytes } from "./bytes";

// Minimal HS256 JWT. The same worker signs and verifies, so a symmetric secret is fine.

export interface SessionClaims {
  sub: string;   // device_id (or "promo:<label>" for test sessions)
  ent: string;   // entitlement type: "storekit" | "promo"
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
  ttlSeconds: number,
  now: number
): Promise<string> {
  const header = bytesToB64Url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const claims: SessionClaims = { sub, ent, iat: now, exp: now + ttlSeconds };
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
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  return claims;
}
