import { Env } from "./env";
import { json, HttpError, bearerToken, clientIp } from "./http";
import { signSession, verifySession, SessionClaims } from "./jwt";
import { issueChallenge, consumeChallenge, rateLimit } from "./limits";
import { serveCachedByVersion } from "./cache";
import { verifyAttestation, verifyAssertion, attestationRequired } from "./appattest";
import { verifyPromoCode, verifyStoreKitTransaction, storeKitXcodeMode, Entitlement, Scope } from "./entitlement";
import {
  getVersion, getManifest, getRows, buildSnapshotNdjson, isTable, ROWS_CAP, searchWord,
  searchCapEnforced, takeSearchRequest, refundSearchRequest, FREE_SEARCH_REQUEST_CAP,
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

// Per-client rate-limit key. Device-backed (StoreKit) sessions are keyed by their device id;
// promo (free) sessions share ONE subject across ALL free users, so they fall back to the
// client IP (per network) — otherwise the limit would be collective for everyone on free.
function rateSubjectKey(claims: SessionClaims, ip: string): string {
  // Prefer the device subject when present (attested sessions, INCLUDING the production
  // free tier, whose sub is the device id). Dev/self-test promo sessions share a
  // "promo:*" subject across all free users, so they fall back to the client IP.
  const sub = claims.sub || "";
  return sub && !sub.startsWith("promo:") ? `dev:${sub}` : `ip:${ip}`;
}

// Keep only letters (incl. German ä/ö/ü/ß) and spaces; strips junk AND SQL LIKE wildcards
// (% and _). The client enforces this too, but the server must never trust the client.
function sanitizeTerm(s: string): string {
  return s.replace(/[^\p{L} ]/gu, "").trim();
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
       sign_count = MAX(sign_count, excluded.sign_count),
       last_seen = datetime('now')`
  ).bind(result.deviceId, result.publicKeySpki, result.signCount).run();
  // sign_count uses MAX(existing, new) so a re-registration can NEVER lower the stored anti-replay
  // baseline (the counter that catches cloned/replayed assertions). device_id = SHA256(pubkey), so
  // a conflict is always the same key; combined with the counter==0 attestation check, a used key
  // can't re-register at all, and this guarantees the baseline is monotonic even if one ever did.

  return json({ deviceId: result.deviceId });
}

interface SessionBody {
  // Free/promo tier. In production this ALSO requires deviceId + assertion + challenge
  // (an attested device); on the dev worker the code alone is enough (self-test).
  promoCode?: string;
  // App Attest device proof. Required for every production session (free and full);
  // omitted only on the dev worker and the local-Xcode StoreKit path.
  deviceId?: string;
  assertion?: string;
  challenge?: string;
  // StoreKit path (full access): a signed transaction to verify the purchase.
  signedTransaction?: string;
}

// Verify an App Attest assertion for a registered device and return its device id.
// Consumes the one-time challenge and advances the stored monotonic sign counter
// (clone/replay defense). Shared by the production free (promo) and full (StoreKit)
// session paths, which both bind their session to a genuine device.
async function verifyDeviceAssertion(env: Env, body: SessionBody): Promise<string> {
  if (!body.deviceId || !body.assertion || !body.challenge) {
    throw new HttpError(400, "missing deviceId/assertion/challenge");
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

  await advanceSignCount(env, body.deviceId, assertion.newSignCount);

  return body.deviceId;
}

// Advances a device's monotonic assertion counter with an atomic compare-and-set.
// verifyAssertion's in-memory `signCount > stored` check is only a fast path: two CONCURRENT
// requests replaying the same assertion both read the same stored count and both pass it
// (TOCTOU). The conditional UPDATE is the authoritative gate — only one writer can satisfy
// `sign_count < ?`, so the clone/replay defense holds under concurrency.
async function advanceSignCount(env: Env, deviceId: string, newCount: number): Promise<void> {
  const res = await env.DB.prepare(
    "UPDATE devices SET sign_count = ?, last_seen = datetime('now') WHERE device_id = ? AND sign_count < ?"
  ).bind(newCount, deviceId, newCount).run();
  if ((res.meta.changes ?? 0) === 0) throw new HttpError(401, "assertion counter reused");
}

// How many DISTINCT attested devices one StoreKit purchase may mint sessions for. Bounds
// Apple-ID sharing / a leaked JWS without troubling a legitimate multi-device user (iPhone +
// iPad + replacements). Devices already bound keep working; only NEW devices past the cap are
// refused. Lifetime purchases have no freshness signal (the JWS is the original transaction),
// so this device binding is the only meaningful replay bound.
const TRANSACTION_DEVICE_CAP = 5;

async function enforceTransactionDeviceCap(
  env: Env, originalTransactionId: string | undefined, deviceId: string
): Promise<void> {
  if (!originalTransactionId) return; // payload carried no identity — nothing to bind on
  const known = await env.DB.prepare(
    "SELECT 1 FROM transaction_devices WHERE original_transaction_id = ? AND device_id = ?"
  ).bind(originalTransactionId, deviceId).first();
  if (known) return; // an already-bound device always keeps working

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM transaction_devices WHERE original_transaction_id = ?"
  ).bind(originalTransactionId).first<{ c: number }>();
  if ((row?.c ?? 0) >= TRANSACTION_DEVICE_CAP) {
    console.warn("transaction device cap reached", { originalTransactionId });
    throw new HttpError(403, "device limit reached for this purchase");
  }

  await env.DB.prepare(
    `INSERT INTO transaction_devices (original_transaction_id, device_id)
     VALUES (?, ?) ON CONFLICT(original_transaction_id, device_id) DO NOTHING`
  ).bind(originalTransactionId, deviceId).run();
}

async function handleSession(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as SessionBody | null;
  if (!body) throw new HttpError(400, "invalid body");

  let entitlement: Entitlement | null = null;
  let subject = "";

  // Best-effort App Attest: verify the device proof IF the client supplied one and it checks out.
  // Attestation is a fraud-reduction SIGNAL here, never a hard gate — a genuine user on a network or
  // device where App Attest can't complete (restrictive Wi-Fi, DeviceCheck hiccup, older/managed
  // device) MUST still get in, like any normal app. When present it upgrades the session to a stable
  // device id (device-scoped search cap + purchase device-cap); when absent we fall back to the
  // credential's own proof — the promo code, or the Apple-VERIFIED purchase.
  const attestedDeviceId = await tryVerifyDeviceAssertion(env, body);

  if (body.promoCode) {
    // ---- Free / promo tier ----
    entitlement = await verifyPromoCode(env, body.promoCode);
    if (!entitlement) throw new HttpError(403, "invalid promo code");
    // Device-scoped when attested (pins the free search cap to hardware); label-scoped otherwise.
    subject = attestedDeviceId ?? `promo:${entitlement.label}`;
  } else if (storeKitXcodeMode(env) && body.signedTransaction && !body.assertion) {
    // ---- Local Xcode testing: StoreKit transaction only, no App Attest (dev only) ----
    entitlement = await verifyStoreKitTransaction(env, body.signedTransaction).catch((e) => {
      console.error("storekit (xcode) failed", { err: String(e) });
      throw new HttpError(403, "entitlement verification failed");
    });
    if (!entitlement) throw new HttpError(403, "no active entitlement");
    subject = `storekit:${entitlement.label}`;
  } else {
    // ---- Production paid tier ----
    // The Apple-VERIFIED StoreKit purchase is the real gate (works on any network). App Attest is
    // best-effort binding on top: enforce the anti-sharing device cap only when we actually have an
    // attested device id; otherwise grant on the verified purchase alone.
    if (!body.signedTransaction) throw new HttpError(400, "missing signedTransaction");
    entitlement = await verifyStoreKitTransaction(env, body.signedTransaction).catch((e) => {
      console.error("storekit failed", { err: String(e) });
      throw new HttpError(403, "entitlement verification failed");
    });
    if (!entitlement) throw new HttpError(403, "no active entitlement");
    if (attestedDeviceId) {
      await enforceTransactionDeviceCap(env, entitlement.originalTransactionId, attestedDeviceId);
      subject = attestedDeviceId;
    } else {
      subject = `storekit:${entitlement.label}`;
    }
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
  if (claims.ent === "storekit" && storeKitXcodeMode(env)) return;

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

  await advanceSignCount(env, deviceId, result.newSignCount);
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
async function handleSearch(
  env: Env, request: Request, ctx: ExecutionContext, claims: SessionClaims
): Promise<Response> {
  const url = new URL(request.url);
  const ip = clientIp(request);
  // Sanitize server-side (letters + spaces only, capped) — strips junk and SQL LIKE wildcards.
  const q = sanitizeTerm(url.searchParams.get("q") || "").slice(0, 64);
  if (q.length < 2) throw new HttpError(400, "query too short");

  // Rate limit per device (StoreKit) or per IP (free/promo, which share a subject). A search is a
  // LIKE scan across all tables, so cap it above human use but below scripted scraping.
  const key = rateSubjectKey(claims, ip);
  if (!(await rateLimit(env, `search:${key}`, 50, 600, nowSeconds()))) {
    console.warn("search rate limited", { key });
    throw new HttpError(429, "rate limited");
  }

  const type = url.searchParams.get("type") || undefined;
  // Version-keyed EDGE cache, like every other read: search deliberately spans the WHOLE
  // dataset (not scope-filtered — hits carry their own `free` flag), so the response is
  // identical for every caller and safe to share; key on the full-scope version so any data
  // change invalidates. Without this, each search was an uncached leading-wildcard LIKE scan
  // of all tables per request. Rate limit + free-cap accounting run BEFORE the cache, so a
  // cache hit still consumes a free search.
  const respond = async (): Promise<Response> => {
    const version = await getVersion(env, "full");
    const tag = `search:${encodeURIComponent(q)}:${type ?? ""}`;
    return serveCachedByVersion(request, ctx, version, tag, 300, async () => ({
      body: JSON.stringify({ query: q, results: await searchWord(env, q, type) }),
      contentType: "application/json",
    }));
  };

  // Free tier: cap total search REQUESTS per device (production only). Full sessions and
  // the dev worker are unrestricted. The client enforces the same cap and short-circuits,
  // so this is the authoritative backstop against direct API abuse (403, not retried).
  // The take is ATOMIC (upsert-RETURNING) so concurrency can't slip past the cap, and a
  // failed search refunds the count so a server error never burns one of the capped requests.
  if (searchCapEnforced(env) && scopeOf(claims) === "free" && claims.sub) {
    const used = await takeSearchRequest(env, claims.sub);
    if (used > FREE_SEARCH_REQUEST_CAP) throw new HttpError(403, "search_limit_reached");
    try {
      return await respond();
    } catch (err) {
      await refundSearchRequest(env, claims.sub);
      throw err;
    }
  }

  return respond();
}

interface SubmissionBody {
  word?: string;
  type?: string;
  // Full-field sharing of a user's custom word (customwords.md CW-FR-ADD-3 / search.md §3):
  // every field optional, every field validated server-side below.
  translation?: string;
  example_de?: string;
  example_en?: string;
  article?: string;
  plural?: string;
  ich?: string; du?: string; er_sie_es?: string;
  wir?: string; ihr?: string; sie_sie?: string;
  simple_past?: string; past_participle?: string;
  comparative?: string; superlative?: string;
}

// Word/form fields: letters + spaces only (the existing sanitizeTerm rule), capped.
// Mirrors the app editor's caps (CustomWordService.wordFieldLimit / sentenceFieldLimit).
const WORD_FIELD_MAX = 100;
// Sentence fields: letters, digits, spaces, and basic sentence punctuation — capped.
// Anything else (markup, emoji, control chars) is stripped; never trust the client.
function sanitizeSentence(s: string): string {
  return s.replace(/[^\p{L}\p{N} .,!?;:'"()\-–—]/gu, "").trim().slice(0, 200);
}

// Submit a missing word for curation. A write path (like /devices/register), so it does
// NOT use the read-only content layer. Rate-limited per session subject; stored as
// 'pending' and never published into the live vocabulary automatically.
async function handleSubmission(
  env: Env, request: Request, claims: SessionClaims
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as SubmissionBody | null;
  const ip = clientIp(request);
  // Sanitize server-side (letters + spaces only, capped) — never trust the client.
  const word = sanitizeTerm(body?.word || "").slice(0, WORD_FIELD_MAX);
  if (word.length < 2) throw new HttpError(400, "missing or invalid word");
  const allowedTypes = ["noun", "verb", "adjective", "adverb"];
  const type = body?.type && allowedTypes.includes(body.type) ? body.type : null;
  const key = rateSubjectKey(claims, ip);

  // Optional full fields of a shared custom word — per-field validation: word/form fields
  // keep the letters/spaces rule; sentence fields allow sentence punctuation; article is a
  // strict enum. Empty after sanitizing → omitted. Stored as one JSON `details` blob for
  // the curator; never written to the published vocabulary tables.
  const details: Record<string, string> = {};
  const wordField = (v?: string) => sanitizeTerm(v || "").slice(0, WORD_FIELD_MAX);
  const put = (k: string, v: string) => { if (v.length > 0) details[k] = v; };
  put("translation", sanitizeSentence(body?.translation || "").slice(0, WORD_FIELD_MAX));
  put("example_de", sanitizeSentence(body?.example_de || ""));
  put("example_en", sanitizeSentence(body?.example_en || ""));
  const article = (body?.article || "").toLowerCase();
  if (["der", "die", "das"].includes(article)) details.article = article;
  put("plural", wordField(body?.plural));
  put("ich", wordField(body?.ich)); put("du", wordField(body?.du));
  put("er_sie_es", wordField(body?.er_sie_es)); put("wir", wordField(body?.wir));
  put("ihr", wordField(body?.ihr)); put("sie_sie", wordField(body?.sie_sie));
  put("simple_past", wordField(body?.simple_past));
  put("past_participle", wordField(body?.past_participle));
  put("comparative", wordField(body?.comparative));
  put("superlative", wordField(body?.superlative));
  const detailsJSON = Object.keys(details).length > 0 ? JSON.stringify(details) : null;

  // Burst limit: a handful of submissions per 10 minutes, per device (StoreKit) or IP (free).
  if (!(await rateLimit(env, `submit:${key}`, 10, 600, nowSeconds()))) {
    console.warn("submit rate limited", { key });
    throw new HttpError(429, "rate limited");
  }

  // Daily cap: bound sustained submission flooding from one client.
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM submissions WHERE source = ? AND created_at > datetime('now', '-1 day')"
  ).bind(key).first<{ c: number }>();
  if ((recent?.c ?? 0) >= 20) {
    console.warn("submit daily cap reached", { key });
    throw new HttpError(429, "daily submission limit reached");
  }

  // Dedup: if this word is already awaiting curation, don't queue it again.
  const existing = await env.DB.prepare(
    "SELECT 1 FROM submissions WHERE word = ? AND status = 'pending' LIMIT 1"
  ).bind(word).first();
  if (existing) return json({ status: "pending" }, 200);

  await env.DB.prepare(
    `INSERT INTO submissions (id, word, type, details, source, scope, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(crypto.randomUUID(), word, type, detailsJSON, key, scopeOf(claims)).run();

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
      // Unauthenticated liveness probe (project rule: every service exposes /health).
      // Deliberately static — it touches no D1/R2, so it can't amplify load, and it lets
      // monitors distinguish "worker down" from "route missing".
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok" });
      }

      if (version !== "v1") return json({ error: "not found" }, 404);

      // Rate-limit the expensive auth endpoints per client IP. Per-route budgets (documented
      // in api-reference.md / promo-codes.md — keep the three in step): `session` is the promo
      // brute-force surface so it gets the tightest budget; a legitimate install needs ~2
      // challenges + 1 register + 1 mint per hour.
      const ip = clientIp(request);
      const authBudget: Record<string, { limit: number; window: number }> = {
        challenge: { limit: 30, window: 60 },
        session: { limit: 10, window: 60 },
        devices: { limit: 10, window: 600 },
      };
      const budget = route ? authBudget[route] : undefined;
      if (budget && !(await rateLimit(env, `${route}:${ip}`, budget.limit, budget.window, nowSeconds()))) {
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
        const claims = await requireSession(env, request);
        return await handleSearch(env, request, ctx, claims);
      }
      if (request.method === "POST" && route === "submissions") {
        const claims = await requireSession(env, request);
        return await handleSubmission(env, request, claims);
      }
      if (request.method === "GET" && route === "audio" && sub === "manifest") {
        const claims = await requireSession(env, request);
        if (!(await rateLimit(env, `audiomanifest:${rateSubjectKey(claims, ip)}`, 60, 600, nowSeconds()))) {
          throw new HttpError(429, "rate limited");
        }
        return await handleAudioManifest(env, request, ctx, scopeOf(claims));
      }
      if (request.method === "GET" && route === "audio" && sub === "pack") {
        const claims = await requireSession(env, request);
        // Generous per-subject cap: a full first sync fetches only a few dozen packs
        // (singular + plural across types/levels), so this never trips legitimate use
        // but bounds scripted bulk scraping of the whole audio catalogue.
        if (!(await rateLimit(env, `audiopack:${rateSubjectKey(claims, ip)}`, 300, 600, nowSeconds()))) {
          throw new HttpError(429, "rate limited");
        }
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
