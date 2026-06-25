import { Env } from "./env";
import { json, HttpError, bearerToken, clientIp } from "./http";
import { signSession, verifySession, SessionClaims } from "./jwt";
import { issueChallenge, consumeChallenge, rateLimit } from "./kv";
import { serveCachedByVersion } from "./cache";
import { verifyAttestation, verifyAssertion } from "./appattest";
import { verifyPromoCode, verifyStoreKitTransaction, Entitlement, Scope } from "./entitlement";
import {
  getVersion, getManifest, getRows, buildSnapshotNdjson, isTable, ROWS_CAP, searchWord,
} from "./data";
import {
  loadManifest, scopedManifest, allowedPacks, normalizePackName, getPackObject,
} from "./audio";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Coerce the JWT's scope claim to a known Scope (unknown -> free, least privilege).
function scopeOf(claims: SessionClaims): Scope {
  return claims.scope === "full" ? "full" : "free";
}

// ---- Auth endpoints ---------------------------------------------------------

async function handleChallenge(env: Env): Promise<Response> {
  const challenge = await issueChallenge(env);
  return json({ challenge });
}

interface RegisterBody {
  keyId: string;
  attestationObject: string;
  challenge: string;
}

async function handleRegister(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as RegisterBody | null;
  if (!body?.keyId || !body.attestationObject || !body.challenge) {
    throw new HttpError(400, "missing keyId/attestationObject/challenge");
  }
  if (!(await consumeChallenge(env, body.challenge))) throw new HttpError(401, "bad challenge");

  const result = await verifyAttestation(env, body.keyId, body.attestationObject, body.challenge)
    .catch((e) => {
      console.error("attestation failed", { err: String(e) });
      throw new HttpError(401, "attestation failed");
    });

  await env.DB.prepare(
    `INSERT INTO devices (device_id, public_key, sign_count, last_seen)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(device_id) DO UPDATE SET
       public_key = excluded.public_key,
       sign_count = excluded.sign_count,
       last_seen = datetime('now')`
  ).bind(result.deviceId, result.publicKeySpki, result.signCount).run();

  return json({ deviceId: result.deviceId });
}

interface SessionBody {
  // Promo path (self-test): no App Attest required.
  promoCode?: string;
  // StoreKit path: requires a registered device + assertion + signed transaction.
  deviceId?: string;
  assertion?: string;
  challenge?: string;
  signedTransaction?: string;
}

async function handleSession(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as SessionBody | null;
  if (!body) throw new HttpError(400, "invalid body");

  let entitlement: Entitlement | null = null;
  let subject = "";

  if (body.promoCode) {
    // ---- Self-test path: promo code only ----
    entitlement = await verifyPromoCode(env, body.promoCode);
    if (!entitlement) throw new HttpError(403, "invalid promo code");
    subject = `promo:${entitlement.label}`;
  } else if (env.STOREKIT_ENV === "xcode" && body.signedTransaction && !body.assertion) {
    // ---- Local Xcode testing: StoreKit transaction only, no App Attest ----
    // Enabled solely by STOREKIT_ENV="xcode". The transaction is locally signed
    // (StoreKit Configuration File), so verifyStoreKitTransaction decodes its
    // claims without Apple verification. NEVER enable this in production.
    entitlement = await verifyStoreKitTransaction(env, body.signedTransaction).catch((e) => {
      console.error("storekit (xcode) failed", { err: String(e) });
      throw new HttpError(403, "entitlement verification failed");
    });
    if (!entitlement) throw new HttpError(403, "no active entitlement");
    subject = `storekit:${entitlement.label}`;
  } else {
    // ---- Production path: App Attest assertion + StoreKit entitlement ----
    if (!body.deviceId || !body.assertion || !body.challenge || !body.signedTransaction) {
      throw new HttpError(400, "missing deviceId/assertion/challenge/signedTransaction");
    }
    if (!(await consumeChallenge(env, body.challenge))) throw new HttpError(401, "bad challenge");

    const device = await env.DB.prepare(
      "SELECT public_key, sign_count FROM devices WHERE device_id = ?"
    ).bind(body.deviceId).first<{ public_key: string; sign_count: number }>();
    if (!device) throw new HttpError(401, "unknown device");

    const assertion = await verifyAssertion(env, {
      deviceId: body.deviceId,
      publicKeySpki: device.public_key,
      storedSignCount: device.sign_count,
      assertionB64: body.assertion,
      challenge: body.challenge,
    }).catch((e) => {
      console.error("assertion failed", { err: String(e) });
      throw new HttpError(401, "assertion failed");
    });

    entitlement = await verifyStoreKitTransaction(env, body.signedTransaction).catch((e) => {
      console.error("storekit failed", { err: String(e) });
      throw new HttpError(403, "entitlement verification failed");
    });
    if (!entitlement) throw new HttpError(403, "no active entitlement");

    await env.DB.prepare(
      "UPDATE devices SET sign_count = ?, last_seen = datetime('now') WHERE device_id = ?"
    ).bind(assertion.newSignCount, body.deviceId).run();

    subject = body.deviceId;
  }

  const ttl = parseInt(env.SESSION_TTL_SECONDS || "3600", 10);
  const token = await signSession(
    env.SESSION_JWT_SECRET, subject, entitlement.type, entitlement.scope, ttl, nowSeconds()
  );
  return json({ token, expiresIn: ttl, entitlement: entitlement.type, scope: entitlement.scope });
}

// ---- Data endpoints (require a valid session JWT) ---------------------------

async function requireSession(env: Env, request: Request): Promise<SessionClaims> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "missing bearer token");
  const claims = await verifySession(env.SESSION_JWT_SECRET, token, nowSeconds());
  if (!claims) throw new HttpError(401, "invalid or expired token");
  return claims;
}

// Per-request App Attest gate for the sensitive bulk endpoint (/v1/snapshot).
// Device-backed (StoreKit) sessions must present a FRESH single-use challenge +
// assertion, signed by the hardware key, with a strictly increasing counter — so
// the full dataset can never be pulled with just a stolen session token.
//
// Promo sessions are exempt: they are an operator-issued self-test credential with
// no device key. Treat promo codes as privileged and scope/expire them tightly.
//
// Note: this gates ACCESS per request; the NDJSON body itself is still served
// from the version-keyed edge cache, so the expensive payload stays cacheable.
async function requireFreshAssertion(
  env: Env, request: Request, claims: SessionClaims
): Promise<void> {
  if (claims.ent === "promo") return;
  // Local Xcode StoreKit sessions have no attested device key, so they can't
  // present an assertion — exempt them (dev only; guarded by STOREKIT_ENV).
  if (claims.ent === "storekit" && env.STOREKIT_ENV === "xcode") return;

  const challenge = request.headers.get("X-Challenge") || "";
  const assertionB64 = request.headers.get("X-Assertion") || "";
  if (!challenge || !assertionB64) {
    throw new HttpError(401, "snapshot requires X-Challenge and X-Assertion headers");
  }
  if (!(await consumeChallenge(env, challenge))) throw new HttpError(401, "bad challenge");

  const deviceId = claims.sub;
  const device = await env.DB.prepare(
    "SELECT public_key, sign_count FROM devices WHERE device_id = ?"
  ).bind(deviceId).first<{ public_key: string; sign_count: number }>();
  if (!device) throw new HttpError(401, "unknown device");

  const result = await verifyAssertion(env, {
    deviceId,
    publicKeySpki: device.public_key,
    storedSignCount: device.sign_count,
    assertionB64,
    challenge,
  }).catch((e) => {
    console.error("snapshot assertion failed", { err: String(e) });
    throw new HttpError(401, "assertion failed");
  });

  await env.DB.prepare(
    "UPDATE devices SET sign_count = ?, last_seen = datetime('now') WHERE device_id = ?"
  ).bind(result.newSignCount, deviceId).run();
}

async function handleVersion(env: Env, scope: Scope): Promise<Response> {
  const version = await getVersion(env, scope);
  return json({ version }, 200, {
    ETag: `"${version}"`,
    "Cache-Control": "public, max-age=30",
  });
}

async function handleManifest(
  env: Env, request: Request, ctx: ExecutionContext, scope: Scope
): Promise<Response> {
  const version = await getVersion(env, scope);
  return serveCachedByVersion(request, ctx, version, `manifest:${scope}`, 300, async () => ({
    body: JSON.stringify({ version, manifest: await getManifest(env, scope) }),
    contentType: "application/json",
  }));
}

async function handleRows(
  env: Env, request: Request, ctx: ExecutionContext, table: string, scope: Scope
): Promise<Response> {
  if (!isTable(table)) throw new HttpError(400, "invalid table");
  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids") || "";
  const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new HttpError(400, "no ids");
  if (ids.length > ROWS_CAP) throw new HttpError(400, `too many ids (max ${ROWS_CAP})`);

  const version = await getVersion(env, scope);
  const tag = `rows:${scope}:${table}:${ids.slice().sort().join(",")}`;
  return serveCachedByVersion(request, ctx, version, tag, 300, async () => ({
    body: JSON.stringify({ version, table, rows: await getRows(env, table, ids, scope) }),
    contentType: "application/json",
  }));
}

async function handleSnapshot(
  env: Env, request: Request, ctx: ExecutionContext, scope: Scope
): Promise<Response> {
  const version = await getVersion(env, scope);
  return serveCachedByVersion(request, ctx, version, `snapshot:${scope}`, 86400, async () => ({
    body: await buildSnapshotNdjson(env, scope),
    contentType: "application/x-ndjson",
  }));
}

// ---- Search & submissions ---------------------------------------------------

// Look up a word for the in-app search. Authenticated, but intentionally searches the
// WHOLE vocabulary (free + full) so a free user can find — and preview — full-set words;
// each hit's `free` flag lets the client mark/lock those. Read-only.
async function handleSearch(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) throw new HttpError(400, "query too short");
  const type = url.searchParams.get("type") || undefined;
  const results = await searchWord(env, q, type);
  return json({ query: q, results }, 200, { "Cache-Control": "private, max-age=60" });
}

interface SubmissionBody {
  word?: string;
  type?: string;
}

// Submit a missing word for curation. A write path (like /devices/register), so it does
// NOT use the read-only content layer. Rate-limited per session subject; stored as
// 'pending' and never published into the live vocabulary automatically.
async function handleSubmission(
  env: Env, request: Request, claims: SessionClaims
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as SubmissionBody | null;
  const word = (body?.word || "").trim();
  if (!word) throw new HttpError(400, "missing word");
  if (word.length > 80) throw new HttpError(400, "word too long");
  const allowedTypes = ["noun", "verb", "adjective", "adverb"];
  const type = body?.type && allowedTypes.includes(body.type) ? body.type : null;

  // Per-session-subject rate limit: a handful of submissions per 10 minutes.
  const subject = claims.sub || "anon";
  if (!(await rateLimit(env, `submit:${subject}`, 10, 600, nowSeconds()))) {
    throw new HttpError(429, "rate limited");
  }

  await env.DB.prepare(
    `INSERT INTO submissions (id, word, type, source, scope, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  ).bind(crypto.randomUUID(), word, type, subject, scopeOf(claims)).run();

  return json({ status: "pending" }, 201);
}

// ---- Audio media endpoints --------------------------------------------------

// Pack manifest, filtered to the caller's scope (free sees only the "free" pack).
async function handleAudioManifest(
  env: Env, request: Request, ctx: ExecutionContext, scope: Scope
): Promise<Response> {
  const scoped = scopedManifest(await loadManifest(env), scope);
  return serveCachedByVersion(request, ctx, scoped.version, `audiomanifest:${scope}`, 300, async () => ({
    body: JSON.stringify(scoped),
    contentType: "application/json",
  }));
}

// Stream one pack blob from R2. Scope is enforced BEFORE the edge-cache lookup so
// a free session can never receive a cached full-tier pack. Cached by pack hash.
async function handleAudioPack(
  env: Env, request: Request, ctx: ExecutionContext, scope: Scope, name: string
): Promise<Response> {
  const manifest = await loadManifest(env);
  const norm = normalizePackName(name);

  // Paywall: must run before any cache read.
  if (!allowedPacks(manifest, scope).has(norm)) {
    throw new HttpError(403, "pack not available for this scope");
  }

  // Key the cache + ETag on `sha` (the actual .pack blob digest), NOT `hash`
  // (content identity). The blob's bytes can change while `hash` stays the same;
  // keying on `hash` would then serve stale bytes that fail the client's sha
  // check. Fall back to `hash` only if an old manifest has no `sha`.
  const sha = manifest.packs[norm]?.sha ?? manifest.packs[norm]?.hash ?? "0";
  const etag = `"${sha}"`;
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const url = new URL(request.url);
  const cache = caches.default;
  const cacheKey = new Request(`https://media-cache.internal${url.pathname}?h=${sha}`, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set("X-Cache", "HIT");
    return new Response(hit.body, { status: hit.status, headers });
  }

  const obj = await getPackObject(env, manifest, scope, norm);
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=86400",
    ETag: etag,
    "X-Cache": "MISS",
  });
  const response = new Response(obj.body, { status: 200, headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ---- Router -----------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["v1", "manifest", ...]
    const [version, route, sub] = parts;

    try {
      if (version !== "v1") return json({ error: "not found" }, 404);

      // Rate-limit the expensive auth endpoints per client IP.
      const ip = clientIp(request);
      const limited = route === "challenge" || route === "session" || route === "devices";
      if (limited && !(await rateLimit(env, `${route}:${ip}`, 60, 600, nowSeconds()))) {
        return json({ error: "rate limited" }, 429);
      }

      if (request.method === "GET" && route === "challenge") {
        return await handleChallenge(env);
      }
      if (request.method === "POST" && route === "devices" && sub === "register") {
        return await handleRegister(env, request);
      }
      if (request.method === "POST" && route === "session") {
        return await handleSession(env, request);
      }

      // Everything below requires a valid session. The session's scope decides
      // whether free (100-word preview) or the full dataset is served.
      if (request.method === "GET" && route === "version") {
        const claims = await requireSession(env, request);
        return await handleVersion(env, scopeOf(claims));
      }
      if (request.method === "GET" && route === "manifest") {
        const claims = await requireSession(env, request);
        return await handleManifest(env, request, ctx, scopeOf(claims));
      }
      if (request.method === "GET" && route === "rows" && sub) {
        const claims = await requireSession(env, request);
        return await handleRows(env, request, ctx, sub, scopeOf(claims));
      }
      if (request.method === "GET" && route === "snapshot") {
        const claims = await requireSession(env, request);
        await requireFreshAssertion(env, request, claims);
        return await handleSnapshot(env, request, ctx, scopeOf(claims));
      }
      if (request.method === "GET" && route === "search") {
        await requireSession(env, request);
        return await handleSearch(env, request);
      }
      if (request.method === "POST" && route === "submissions") {
        const claims = await requireSession(env, request);
        return await handleSubmission(env, request, claims);
      }
      if (request.method === "GET" && route === "audio" && sub === "manifest") {
        const claims = await requireSession(env, request);
        return await handleAudioManifest(env, request, ctx, scopeOf(claims));
      }
      if (request.method === "GET" && route === "audio" && sub === "pack") {
        const claims = await requireSession(env, request);
        // Pack name may contain a slash ("nouns/a1.1"): join the trailing parts.
        const name = parts.slice(3).join("/");
        if (!name) throw new HttpError(400, "missing pack name");
        return await handleAudioPack(env, request, ctx, scopeOf(claims), name);
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.code }, err.status);
      }
      console.error("unhandled error", { err: String(err) });
      return json({ error: "internal error" }, 500);
    }
  },
};
