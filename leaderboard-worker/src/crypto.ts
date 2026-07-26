// Crypto primitives + the social JWT (batch W2).
//
// HS256 JWT (symmetric — only this worker verifies, contract §"auth mechanics"),
// key-versioned identity HMAC (IDENT-2), Apple identity-token verification against
// Apple's JWKS via WebCrypto. No third-party crypto dependencies.

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return b64urlEncode(raw);
}

async function hmacKey(secret: string, usages: ("sign" | "verify")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

/** Key-versioned identity hash: HMAC(secret_vN, provider:subject) → hex (IDENT-2).
 *  The raw provider subject exists only inside this call. */
export async function hashedSubject(secret: string, provider: string, subject: string): Promise<string> {
  const key = await hmacKey(secret, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${provider}:${subject}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- social JWT (HS256) -----------------------------------------------------

export interface SessionClaims {
  sub: string;      // player id
  aud: "leaderboard";
  /** Application tenant (the URL's first path segment: "german", later "spanish", …).
   *  `aud` says WHICH SERVICE the token is for; `app` says WHICH APP'S DATA it may
   *  touch. They are different questions and must not be conflated — a token minted
   *  for one language is structurally unusable against another even if the two ever
   *  share a signing secret or an auth service. Never inferred, never defaulted. */
  app: string;
  env: string;
  sv: number;       // session_version (bumped to revoke everything)
  fam: string;      // refresh family (sign-out target)
  iat: number;
  exp: number;
  jti: string;
}

export async function mintJwt(secret: string, claims: SessionClaims): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Verify signature + structure; returns claims or null. Semantic checks (aud, env,
 *  exp, sv) belong to the caller so refusals map to distinct stable codes. */
export async function verifyJwt(secret: string, token: string): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const key = await hmacKey(secret, ["verify"]);
    const ok = await crypto.subtle.verify(
      "HMAC", key, b64urlDecode(parts[2]) as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as SessionClaims;
  } catch {
    return null;
  }
}

// --- Apple identity token (RS256 against Apple's JWKS) ----------------------

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }

// Isolate-scoped JWKS cache — refreshed hourly, refetched once on a kid miss
// (Apple rotates keys; a stale cache must not strand sign-ins).
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function appleJwks(forceRefresh: boolean): Promise<Jwk[]> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < 3_600_000;
  if (!jwksCache || !fresh || forceRefresh) {
    const response = await fetch("https://appleid.apple.com/auth/keys");
    if (!response.ok) throw new Error(`apple jwks ${response.status}`);
    jwksCache = { keys: ((await response.json()) as { keys: Jwk[] }).keys, fetchedAt: Date.now() };
  }
  return jwksCache.keys;
}

export interface ProviderIdentity { subject: string; nonce?: string }

/** Full Apple identity-token verification: signature (JWKS), issuer, audience,
 *  expiry. Returns subject + embedded nonce, or null. */
export async function verifyAppleIdentityToken(
  token: string, expectedAudience: string, now = Date.now(),
): Promise<ProviderIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as { kid?: string; alg?: string };
    if (header.alg !== "RS256" || !header.kid) return null;
    let jwk = (await appleJwks(false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await appleJwks(true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]) as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as {
      iss?: string; aud?: string; sub?: string; exp?: number; nonce?: string;
    };
    if (claims.iss !== "https://appleid.apple.com") return null;
    if (claims.aud !== expectedAudience) return null;
    if (!claims.sub || !claims.exp || claims.exp * 1000 < now) return null;
    return { subject: claims.sub, nonce: claims.nonce };
  } catch {
    return null;
  }
}
