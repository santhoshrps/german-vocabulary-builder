import { Env } from "./env";
import { json, HttpError, bearerToken, clientIp } from "./http";
import { signSession, verifySession, issuerFor, SessionClaims } from "./jwt";
import {
  issueChallenge, consumeChallenge, rateLimit,
  searchCapEnforced, takeSearchRequest, refundSearchRequest, FREE_SEARCH_REQUEST_CAP,
} from "./limits";
import { opsQuery } from "./db";
import { issueGrants, serveFile, GRANTS_MAX_IDS } from "./mediafiles";
import { healthReport } from "./health";
import { serveCachedByVersion } from "./cache";
import { resolveChain, chainKey, isKnownLang } from "./languages";
import { verifyAttestation, verifyAssertion, attestationRequired } from "./appattest";
import { verifyPromoCode, verifyStoreKitTransaction, storeKitXcodeMode, claimPromoDevice, Entitlement, Scope } from "./entitlement";
import {
  getVersion, getManifest, getRows, buildSnapshotNdjson, isTable, ROWS_CAP, searchWord,
  getAliases,
} from "./data";
import {
  loadManifest, scopedManifest, allowedPacks, normalizePackName, getPackObject,
  presignPackURL, PACK_URL_TTL_SECONDS,
} from "./audio";
import { sha256, utf8 } from "./bytes";

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

  await opsQuery(env, 
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

  const device = await opsQuery(env, 
    "SELECT public_key, sign_count FROM devices WHERE device_id = ?"
  ).bind(body.deviceId).first<{ public_key: string; sign_count: number }>();
  if (!device) throw new HttpError(401, "unknown device");

  const input = {
    deviceId: body.deviceId,
    publicKeySpki: device.public_key,
    storedSignCount: device.sign_count,
    assertionB64: body.assertion,
    challenge: body.challenge,
  };
  // Request binding (AA-M1): the assertion also signs the session credential, so a captured
  // challenge+assertion pair can't be attached to a DIFFERENT promo code / transaction.
  const credential = body.promoCode ?? body.signedTransaction;
  const bindingDigest = credential ? await sha256(utf8(credential)) : undefined;

  let assertion;
  try {
    assertion = await verifyAssertion(env, { ...input, bindingDigest });
  } catch (boundErr) {
    // Rollout window: app builds released before the binding sign the challenge alone.
    // Accept that legacy form (logged, so its disappearance is observable) until every
    // device updates, then DELETE this fallback — tracked in the app repo's
    // docs/deferred.md App Attest entry. Both verifies are pure local crypto; the one-time
    // challenge was consumed once above, so the retry costs nothing security-wise.
    try {
      assertion = await verifyAssertion(env, input);
      console.warn("legacy unbound assertion accepted", { deviceId: body.deviceId });
    } catch {
      console.error("assertion failed", { err: String(boundErr) });
      throw new HttpError(401, "assertion failed");
    }
  }

  await advanceSignCount(env, body.deviceId, assertion.newSignCount);

  return body.deviceId;
}

// Best-effort variant of verifyDeviceAssertion (the missing half of commit e4dd551, which
// switched handleSession to this API): App Attest here is a fraud-reduction SIGNAL, never a
// hard gate — see the call site. Returns the attested device id when a complete proof
// (deviceId + assertion + challenge) is supplied AND verifies; null when the proof is absent
// or fails (logged). A failed proof is treated exactly like an omitted one — the caller's
// real gates (promo code / Apple-verified purchase) still apply either way, so soft-failing
// grants nothing an attacker couldn't get by simply omitting the proof.
async function tryVerifyDeviceAssertion(env: Env, body: SessionBody): Promise<string | null> {
  if (!body.deviceId || !body.assertion || !body.challenge) return null;
  try {
    return await verifyDeviceAssertion(env, body);
  } catch (err) {
    console.warn("best-effort device assertion failed", { err: String(err) });
    return null;
  }
}

// Advances a device's monotonic assertion counter with an atomic compare-and-set.
// verifyAssertion's in-memory `signCount > stored` check is only a fast path: two CONCURRENT
// requests replaying the same assertion both read the same stored count and both pass it
// (TOCTOU). The conditional UPDATE is the authoritative gate — only one writer can satisfy
// `sign_count < ?`, so the clone/replay defense holds under concurrency.
async function advanceSignCount(env: Env, deviceId: string, newCount: number): Promise<void> {
  const res = await opsQuery(env, 
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
  const known = await opsQuery(env, 
    "SELECT 1 FROM transaction_devices WHERE original_transaction_id = ? AND device_id = ?"
  ).bind(originalTransactionId, deviceId).first();
  if (known) return; // an already-bound device always keeps working

  const row = await opsQuery(env, 
    "SELECT COUNT(*) AS c FROM transaction_devices WHERE original_transaction_id = ?"
  ).bind(originalTransactionId).first<{ c: number }>();
  if ((row?.c ?? 0) >= TRANSACTION_DEVICE_CAP) {
    console.warn("transaction device cap reached", { originalTransactionId });
    throw new HttpError(403, "device limit reached for this purchase");
  }

  await opsQuery(env, 
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
    // Personal full-access codes (UA-FR-4b): a full-tier code binds to the first
    // PROMO_DEVICE_CAP attested devices that redeem it; everyone else is turned away. The
    // free built-in code is deliberately exempt (scope "free" — it's shared by every
    // install), and so is the dev worker (Xcode/Simulator builds can't attest, mirroring
    // its existing StoreKit relaxation). Error contract, matched by the app on status +
    // body ("403 code recovery" in VocabularyAPIClient.ensureOK):
    //   403 "code already in use…"      — dead FOR THIS DEVICE: drop the stored code, prompt.
    //   503 "device check required…"    — TRANSIENT (App Attest throttled at first-ever
    //        redemption): NOT a credential rejection, so a stored code survives it
    //        (UA-FR-4c) and the redeem UI says "try again in a little while".
    if (entitlement.scope === "full" && !storeKitXcodeMode(env)) {
      const claim = await claimPromoDevice(env, entitlement.codeHash!, attestedDeviceId ?? null);
      if (claim === "code-in-use") {
        throw new HttpError(403, "code already in use on the maximum number of devices");
      }
      if (claim === "device-check-required") {
        throw new HttpError(503, "device check required - try again shortly");
      }
    }
    // Device-scoped when attested (pins the free search cap to hardware); label-scoped otherwise.
    subject = attestedDeviceId ?? `promo:${entitlement.label}`;
  } else if (storeKitXcodeMode(env) && body.signedTransaction && !body.assertion) {
    // ---- Local Xcode testing: StoreKit transaction only, no App Attest (dev only) ----
    entitlement = await verifyStoreKitTransaction(env, body.signedTransaction).catch((e) => {
      console.error("storekit (xcode) failed", { err: String(e) });
      throw new HttpError(403, "entitlement verification failed");
    });
    if (!entitlement) throw new HttpError(403, "no active entitlement");
    subject = `storekit:${entitlement.originalTransactionId ?? entitlement.label}`;
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
      // M17: key the subject on the PURCHASE, not the product. Every paid user shares one
      // product label, so `storekit:<label>` made all unattested paid sessions one shared
      // rate-limit bucket — one abuser could 429 every paid-but-unattested user's media
      // sync. The Apple-verified originalTransactionId is unique per purchase (already
      // used for the device cap above); label remains only as a last-resort fallback for
      // a payload that carried no transaction identity.
      subject = `storekit:${entitlement.originalTransactionId ?? entitlement.label}`;
    }
  }

  const ttl = parseInt(env.SESSION_TTL_SECONDS || "3600", 10);
  const token = await signSession(
    env.SESSION_JWT_SECRET, issuerFor(env.ENV_NAME), subject, entitlement.type, entitlement.scope,
    ttl, nowSeconds()
  );
  return json({ token, expiresIn: ttl, entitlement: entitlement.type, scope: entitlement.scope });
}

// ---- Data endpoints (require a valid session JWT) ---------------------------

async function requireSession(env: Env, request: Request): Promise<SessionClaims> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "missing bearer token");
  // Current key, plus the previous one during a rotation grace window (MS2-FR-30e).
  const secrets = [env.SESSION_JWT_SECRET, env.SESSION_JWT_SECRET_PREVIOUS].filter(
    (s): s is string => !!s
  );
  const claims = await verifySession(secrets, issuerFor(env.ENV_NAME), token, nowSeconds());
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
  // PURCHASE-ONLY sessions (2026-07-12): a paid device that could not complete App
  // Attest at mint gets in on the Apple-verified purchase alone, with a
  // `storekit:<label>` subject instead of a device id (see handleSession). That device
  // has no hardware key to assert with, so DEMANDING a fresh assertion here contradicts
  // the best-effort mint and hard-bricks exactly the device class the mint promised to
  // admit (owner report: a paid device throttled by Apple after many same-day reinstalls
  // could not download words). The requirement is meaningful ONLY for a DEVICE-BOUND
  // session (subject = the attested device id) — those still enforce fresh proof, so a
  // stolen device-bound token still can't pull the bulk dataset. The verified purchase
  // is the gate for the purchase-only path.
  if (claims.sub.startsWith("storekit:")) return;

  const challenge = request.headers.get("X-Challenge") || "";
  const assertionB64 = request.headers.get("X-Assertion") || "";
  if (!challenge || !assertionB64) {
    throw new HttpError(401, "snapshot requires X-Challenge and X-Assertion headers");
  }
  if (!(await consumeChallenge(env, challenge))) throw new HttpError(401, "bad challenge");

  const deviceId = claims.sub;
  const device = await opsQuery(env, 
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
  // minClient: the forward-compat floor (MS2-FR-23). Clients compare it to their
  // own content-schema generation and show a friendly update prompt when behind.
  const minClient = parseInt(env.MIN_CLIENT_GENERATION ?? "1", 10) || 1;
  return json({ version, minClient }, 200, {
    ETag: `"${version}:${minClient}"`,
    "Cache-Control": "public, max-age=30",
  });
}

async function handleManifest(
  env: Env, request: Request, ctx: ExecutionContext, scope: Scope
): Promise<Response> {
  const version = await getVersion(env, scope);
  // The manifest is language-resolved (composite hashes, LG-FR-13): the chain is
  // part of the cached body's identity AND its ETag — two languages must never
  // share a 304 or a cached entry.
  const chain = resolveChain(new URL(request.url).searchParams.get("lang"));
  const key = chainKey(chain);
  return serveCachedByVersion(request, ctx, `${version}:${key}`, `manifest:${scope}:${key}`, 300, async () => ({
    body: JSON.stringify({ version, manifest: await getManifest(env, scope, chain) }),
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
  const chain = resolveChain(url.searchParams.get("lang"));
  const key = chainKey(chain);
  const tag = `rows:${scope}:${key}:${table}:${ids.slice().sort().join(",")}`;
  return serveCachedByVersion(request, ctx, `${version}:${key}`, tag, 300, async () => ({
    body: JSON.stringify({ version, table, rows: await getRows(env, table, ids, scope, chain) }),
    contentType: "application/json",
  }));
}

async function handleSnapshot(
  env: Env, request: Request, ctx: ExecutionContext, scope: Scope
): Promise<Response> {
  const version = await getVersion(env, scope);
  const chain = resolveChain(new URL(request.url).searchParams.get("lang"));
  const key = chainKey(chain);
  return serveCachedByVersion(request, ctx, `${version}:${key}`, `snapshot:${scope}:${key}`, 86400, async () => ({
    body: await buildSnapshotNdjson(env, scope, chain),
    // text/plain, not application/x-ndjson (2026-07-12): the client parses BYTES and never
    // reads this header, and only types on Cloudflare's compressible list get wire
    // compression — x-ndjson isn't listed, which shipped the ~20 MB snapshot raw. This is
    // the ONLY sanctioned compression mechanism here; never hand-gzip a response (the
    // double-gzip incident, see cache.ts).
    contentType: "text/plain; charset=utf-8",
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
  // Two letters minimum for alphabetic queries — but ONE CJK ideograph/kana is a
  // complete word (Chinese source language, LG-FR-13), so it searches alone.
  const cjk = /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF]/u.test(q);
  if (q.length < (cjk ? 1 : 2)) throw new HttpError(400, "query too short");

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
  const chain = resolveChain(url.searchParams.get("lang"));
  const langKey = chainKey(chain);
  const respond = async (): Promise<Response> => {
    const version = await getVersion(env, "full");
    const tag = `search:${langKey}:${encodeURIComponent(q)}:${type ?? ""}`;
    return serveCachedByVersion(request, ctx, `${version}:${langKey}`, tag, 300, async () => ({
      body: JSON.stringify({ query: q, results: await searchWord(env, q, type, chain) }),
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
  /// Stable per-word key (`custom-<uuid>`) for share upserts — absent on search-submits.
  client_key?: string;
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
  // The submitter's source language (LG-FR-14): the app sends ?lang= on every
  // request; validated against the registry, so the curator knows which language
  // the shared translation text is written in. Unknown/absent → "en".
  const langParam = new URL(request.url).searchParams.get("lang") ?? "";
  const lang = isKnownLang(langParam) ? langParam : "en";
  const key = rateSubjectKey(claims, ip);
  // Stable per-word client key (the app's `custom-<uuid>`): repeated shares of ONE word —
  // first save, then every edit (app spec CW-FR-ADD-6) — UPSERT the same curation row, so
  // the curator always sees one current version instead of a history of near-duplicates.
  // Strict shape; anything else is treated as absent (search-submits carry no key).
  const clientKey = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    .test(body?.client_key || "") ? (body!.client_key as string) : null;

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
  const recent = await opsQuery(env, 
    "SELECT COUNT(*) AS c FROM submissions WHERE source = ? AND created_at > datetime('now', '-1 day')"
  ).bind(key).first<{ c: number }>();
  if ((recent?.c ?? 0) >= 20) {
    console.warn("submit daily cap reached", { key });
    throw new HttpError(429, "daily submission limit reached");
  }

  // Keyed share: upsert this word's own row. An APPROVED word is already in the curation
  // pipeline — edits don't reopen it here; a rejected one returns to 'pending' (the user
  // improved it, the curator re-reviews). created_at refreshes so the curator sees recency;
  // the daily cap counts rows, so edits of one word never eat the submission budget.
  if (clientKey) {
    const mine = await opsQuery(env, 
      "SELECT status FROM submissions WHERE client_key = ? LIMIT 1"
    ).bind(clientKey).first<{ status: string }>();
    if (mine) {
      if (mine.status === "approved") return json({ status: "approved" }, 200);
      await opsQuery(env, 
        `UPDATE submissions SET word = ?, type = ?, details = ?, status = 'pending',
                created_at = datetime('now') WHERE client_key = ?`
      ).bind(word, type, detailsJSON, clientKey).run();
      return json({ status: "pending" }, 200);
    }
  } else {
    // Keyless (search-submit) dedup: if this word is already awaiting curation, don't queue
    // it again. Keyed shares skip this — the user's own word must not be swallowed by an
    // unrelated pending row that happens to share the spelling.
    const existing = await opsQuery(env, 
      "SELECT 1 FROM submissions WHERE word = ? AND status = 'pending' LIMIT 1"
    ).bind(word).first();
    if (existing) return json({ status: "pending" }, 200);
  }

  await opsQuery(env, 
    `INSERT INTO submissions (id, word, type, details, source, scope, status, client_key, lang)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(crypto.randomUUID(), word, type, detailsJSON, key, scopeOf(claims), clientKey, lang).run();

  return json({ status: "pending" }, 201);
}

interface FeedbackBody {
  text?: string;
  app_version?: string;
  cefr_level?: string;
  locale?: string;
  kind?: string;
  contact_email?: string;
}

// The channels feedback can arrive from (settings.md ST-FR-FDBK-2). Anything else is stored
// as 'other' rather than rejected — a mislabelled message is still a message worth reading.
const FEEDBACK_KINDS = ["review", "feature", "bug", "content", "other"] as const;

// How long an OPTIONAL reply address survives (ST-FR-FDBK-5). The feedback text is kept;
// only the address expires, so the archive stays useful and stops being personal data.
const FEEDBACK_CONTACT_TTL_DAYS = 30;

// A deliberately conservative address check: this is a reply-to hint, not an identity. Long
// or exotic input is dropped (stored as NULL) rather than rejected — losing an address must
// never cost us the feedback itself.
const FEEDBACK_EMAIL_MAX = 254;
function sanitizeContactEmail(s: string | undefined): string | null {
  const trimmed = (s || "").trim();
  if (!trimmed || trimmed.length > FEEDBACK_EMAIL_MAX) return null;
  return /^[^\s@,;:<>()[\]\\]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/
    .test(trimmed) ? trimmed : null;
}

/// Erases reply addresses past their expiry, everywhere (ST-FR-FDBK-5). Idempotent and
/// indexed, so it is cheap to run often — it is called opportunistically after each write
/// AND from the daily cron, because a promise to delete cannot depend on someone happening
/// to send more feedback.
async function purgeExpiredFeedbackContacts(env: Env): Promise<number> {
  const result = await opsQuery(env,
    `UPDATE feedback SET contact_email = NULL, contact_expires_at = NULL
      WHERE contact_email IS NOT NULL
        AND (contact_expires_at IS NULL OR contact_expires_at <= datetime('now'))`
  ).run();
  return result.meta?.changes ?? 0;
}

// Feedback text: same charset as sentence fields plus newlines, capped at 500 (the app's
// reviews.md RV-FR-FDBK-2 cap, re-enforced here — never trust the client).
const FEEDBACK_TEXT_MAX = 500;
function sanitizeFeedback(s: string): string {
  return s.replace(/[^\p{L}\p{N} .,!?;:'"()\-–—\n]/gu, "").trim().slice(0, FEEDBACK_TEXT_MAX);
}

// Content reports (words.md WD-REP-5): a learner flagged a clip/picture/card. Same write
// discipline as /submissions and /feedback — session-authenticated, per-field validated,
// burst + daily capped per subject, stored 'pending' for MANUAL curator review only.
interface ReportBody {
  word_id?: string;
  kind?: string;
  reason?: string;
  comment?: string;
  fingerprint?: string;
  app_version?: string;
}

const REPORT_KINDS = new Set(["word", "plural", "sentence", "image", "card"]);
const REPORT_REASONS = new Set([
  "sounds-wrong", "mismatch", "poor-quality",   // audio (WD-REP-2)
  "inappropriate",                              // picture adds this; shares the other two
]);

async function handleContentReport(
  env: Env, request: Request, claims: SessionClaims
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as ReportBody | null;
  const ip = clientIp(request);

  // Identity fields are strict: a malformed word id / kind is a rejected report (there
  // is nothing reviewable without them). Reason must be a known slug on media reports;
  // the card report carries free text instead (comment) and no reason.
  const wordId = (body?.word_id || "").toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(wordId)) throw new HttpError(400, "invalid word id");
  const kind = body?.kind || "";
  if (!REPORT_KINDS.has(kind)) throw new HttpError(400, "invalid kind");
  const reason = body?.reason || "";
  if (kind === "card") {
    if (reason) throw new HttpError(400, "card reports carry no reason");
  } else if (!REPORT_REASONS.has(reason)) {
    throw new HttpError(400, "invalid reason");
  }
  const comment = sanitizeFeedback(body?.comment || "");
  if (kind === "card" && comment.length < 2) throw new HttpError(400, "missing text");
  const fingerprint = /^[0-9a-f]{16,64}$/.test(body?.fingerprint || "")
    ? (body!.fingerprint as string) : null;
  const appVersion = /^[0-9]+(\.[0-9]+){0,3}$/.test(body?.app_version || "")
    ? (body!.app_version as string) : "unknown";

  const key = rateSubjectKey(claims, ip);
  // Burst: a handful per 10 minutes; daily cap bounds sustained flooding (WD-REP-5).
  if (!(await rateLimit(env, `reports:${key}`, 5, 600, nowSeconds()))) {
    console.warn("report rate limited", { key });
    throw new HttpError(429, "rate limited");
  }
  const recent = await opsQuery(env,
    "SELECT COUNT(*) AS c FROM content_reports WHERE subject = ? AND created_at > datetime('now', '-1 day')"
  ).bind(key).first<{ c: number }>();
  if ((recent?.c ?? 0) >= 20) {
    console.warn("report daily cap reached", { key });
    throw new HttpError(429, "daily report limit reached");
  }

  await opsQuery(env,
    `INSERT INTO content_reports (id, word_id, kind, reason, comment, fingerprint, subject, app_version, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(crypto.randomUUID(), wordId, kind, reason || null, comment || null,
         fingerprint, key, appVersion).run();

  console.log(JSON.stringify({ evt: "REPORT", kind, reason: reason || "-" }));
  return json({ status: "received" }, 201);
}

// Diagnostics reports (docs/diagnostics.md DG-FR-10/11): a user-initiated, gzipped,
// privacy-clean report. Same write discipline as /reports — session-authenticated,
// validated, rate-limited per subject. Body is the raw gzip; identity rides in headers
// so indexing needs no decompression. Stored in R2 (metadata = the index); reports
// self-expire: each upload opportunistically prunes objects older than 30 days.
const DIAGNOSTICS_MAX_BYTES = 4 * 1024 * 1024;
const DIAGNOSTICS_TTL_MS = 30 * 24 * 3600 * 1000;

async function handleDiagnostics(
  env: Env, request: Request, ctx: ExecutionContext, claims: SessionClaims
): Promise<Response> {
  if (!env.MEDIA) throw new HttpError(503, "storage not configured");
  const reportId = (request.headers.get("X-Report-Id") || "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reportId)) {
    throw new HttpError(400, "invalid report id");
  }
  const build = /^[0-9A-Za-z.]{1,20}$/.test(request.headers.get("X-App-Build") || "")
    ? (request.headers.get("X-App-Build") as string) : "unknown";

  const key = rateSubjectKey(claims, clientIp(request));
  // A few per day is plenty for a frustrated user and useless for abuse (DG-FR-10).
  if (!(await rateLimit(env, `diagnostics:${key}`, 3, 86_400, nowSeconds()))) {
    console.warn("diagnostics rate limited", { key });
    throw new HttpError(429, "rate limited");
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > DIAGNOSTICS_MAX_BYTES) throw new HttpError(413, "report too large");
  // Must actually BE gzip (RFC 1952 magic) — reject arbitrary blobs into storage.
  if (body.byteLength < 20 || body[0] !== 0x1f || body[1] !== 0x8b) {
    throw new HttpError(400, "not gzip");
  }

  const date = new Date().toISOString().slice(0, 10);
  const objectKey = `diagnostics/${date}-${reportId}.json.gz`;
  await env.MEDIA.put(objectKey, body, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { build, bytes: String(body.byteLength) },
  });

  // DG-FR-11: retention without operator action — prune >30d siblings after responding.
  ctx.waitUntil((async () => {
    const now = Date.now();
    const list = await env.MEDIA!.list({ prefix: "diagnostics/" });
    for (const obj of list.objects) {
      if (now - obj.uploaded.getTime() > DIAGNOSTICS_TTL_MS) await env.MEDIA!.delete(obj.key);
    }
  })());

  console.log(JSON.stringify({ evt: "DIAGNOSTICS", id: reportId.slice(0, 8), bytes: body.byteLength, build }));
  return json({ status: "received", id: reportId }, 201);
}

// "Not enjoying" review feedback from the app (reviews.md RV-FR-FDBK). A write path like
// /submissions: session-authenticated, per-field validated, rate-limited per subject, stored
// as 'new' for manual operator review. D1 only — deliberately no e-mail/notification leg.
async function handleFeedback(
  env: Env, request: Request, ctx: ExecutionContext, claims: SessionClaims
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as FeedbackBody | null;
  const ip = clientIp(request);

  const text = sanitizeFeedback(body?.text || "");
  if (text.length < 2) throw new HttpError(400, "missing or invalid text");
  // Metadata fields: strict shape checks, never free-form (invalid → generic placeholder,
  // not a rejection — the feedback text is the payload that matters).
  const appVersion = /^[0-9]+(\.[0-9]+){0,3}$/.test(body?.app_version || "")
    ? (body!.app_version as string) : "unknown";
  const cefrLevel = /^[A-Ca-c][12](\.[0-9]{1,2})?$/.test(body?.cefr_level || "")
    ? (body!.cefr_level as string).toUpperCase() : "unknown";
  const locale = /^[A-Za-z0-9_-]{2,20}$/.test(body?.locale || "")
    ? (body!.locale as string) : "unknown";
  // Unknown channels become 'other' — never a rejection (see FEEDBACK_KINDS).
  const kind = FEEDBACK_KINDS.includes(body?.kind as typeof FEEDBACK_KINDS[number])
    ? (body!.kind as string) : "other";
  const contactEmail = sanitizeContactEmail(body?.contact_email);

  const key = rateSubjectKey(claims, ip);

  // Burst limit: a couple of feedback messages per 10 minutes per subject.
  if (!(await rateLimit(env, `feedback:${key}`, 3, 600, nowSeconds()))) {
    console.warn("feedback rate limited", { key });
    throw new HttpError(429, "rate limited");
  }

  // Daily cap: bound sustained flooding from one client (RV-FR-FDBK-6). Ten, not three
  // (owner 2026-07-22): the Settings form is opened DELIBERATELY, and someone with several
  // ideas in one day must not be silently swallowed. The 10-minute burst guard above is what
  // actually stops flooding.
  const recent = await opsQuery(env,
    "SELECT COUNT(*) AS c FROM feedback WHERE subject = ? AND created_at > datetime('now', '-1 day')"
  ).bind(key).first<{ c: number }>();
  if ((recent?.c ?? 0) >= 10) {
    console.warn("feedback daily cap reached", { key });
    throw new HttpError(429, "daily feedback limit reached");
  }

  // Expiry computed here and bound plainly — the deletion deadline is data, and data belongs
  // in a parameter, not spliced into SQL. Same "YYYY-MM-DD HH:MM:SS" UTC shape D1's
  // datetime('now') writes, so the sweep's comparison is a plain string compare.
  const contactExpires = contactEmail
    ? new Date(Date.now() + FEEDBACK_CONTACT_TTL_DAYS * 86_400_000)
        .toISOString().replace("T", " ").slice(0, 19)
    : null;

  await opsQuery(env,
    `INSERT INTO feedback
       (id, subject, text, app_version, cefr_level, locale, status, kind,
        contact_email, contact_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`
  ).bind(crypto.randomUUID(), key, text, appVersion, cefrLevel, locale, kind,
         contactEmail, contactExpires).run();

  // Retention without operator action (ST-FR-FDBK-5), same opportunistic shape as the
  // diagnostics prune (DG-FR-11) — the daily cron is the guarantee, this is the fast path.
  ctx.waitUntil(purgeExpiredFeedbackContacts(env).catch(() => 0));

  console.log(JSON.stringify({ evt: "FEEDBACK", kind, reply: contactEmail !== null }));
  return json({ status: "received" }, 201);
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
  // MEDIATRACE: the Cache API silently no-ops on workers.dev hosts — the client's per-pack
  // trace shows this header so a cache-incapable deployment names itself instead of
  // masquerading as an eternal MISS.
  const cacheCapable = url.hostname.endsWith(".workers.dev") ? "no-workers.dev" : "yes";
  const cache = caches.default;
  const cacheKey = new Request(`https://media-cache.internal${url.pathname}?h=${sha}`, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set("X-Cache", "HIT");
    headers.set("X-Cache-Capable", cacheCapable);
    headers.set("Server-Timing", "edge;desc=hit");
    console.log(JSON.stringify({ evt: "MEDIATRACE pack", name: norm, cache: "HIT" }));
    return new Response(hit.body, { status: hit.status, headers });
  }

  const r2Start = Date.now();
  const obj = await getPackObject(env, manifest, scope, norm);
  const r2ms = Date.now() - r2Start;   // time-to-first-byte from R2; streaming continues after
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=86400",
    ETag: etag,
    "X-Cache": "MISS",
    "X-Cache-Capable": cacheCapable,
    "Server-Timing": `r2;dur=${r2ms}`,
  });
  const response = new Response(obj.body, { status: 200, headers });
  console.log(JSON.stringify({
    evt: "MEDIATRACE pack", name: norm, cache: "MISS", cacheCapable, r2ms,
    bytes: manifest.packs[norm]?.bytes ?? 0,
  }));
  // A failed store must be VISIBLE — a pack that never caches re-streams from R2 for every
  // user forever, which reads as "downloads are slow" with no error anywhere.
  ctx.waitUntil(cache.put(cacheKey, response.clone()).catch((err) => {
    console.warn(JSON.stringify({ evt: "MEDIATRACE cache-put-failed", name: norm, err: String(err) }));
  }));
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
      // monitors distinguish "worker down" from "route missing". Reports environment
      // identity, deployed version, and a names-only config self-check (MS2-FR-30b/30c);
      // scripts/deploy.sh asserts all three after every deploy.
      if (request.method === "GET" && url.pathname === "/health") {
        return json(healthReport(env));
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
      // Identity re-key map (WD-ID-4/5): id_aliases as one cached JSON body.
      if (request.method === "GET" && route === "aliases") {
        const claims = await requireSession(env, request);
        const version = await getVersion(env, scopeOf(claims));
        return await serveCachedByVersion(request, ctx, `${version}:aliases`, "aliases", 3600, async () => ({
          body: JSON.stringify({ version, aliases: await getAliases(env) }),
          contentType: "application/json",
        }));
      }
      if (request.method === "GET" && route === "search") {
        const claims = await requireSession(env, request);
        return await handleSearch(env, request, ctx, claims);
      }
      if (request.method === "POST" && route === "submissions") {
        const claims = await requireSession(env, request);
        return await handleSubmission(env, request, claims);
      }
      if (request.method === "POST" && route === "feedback") {
        const claims = await requireSession(env, request);
        return await handleFeedback(env, request, ctx, claims);
      }
      // Content reports (words.md WD-REP-5): pending rows for manual curator review.
      if (request.method === "POST" && route === "reports") {
        const claims = await requireSession(env, request);
        return await handleContentReport(env, request, claims);
      }
      // Diagnostics reports (docs/diagnostics.md DG-FR-10): user-initiated log bundles.
      if (request.method === "POST" && route === "diagnostics") {
        const claims = await requireSession(env, request);
        return await handleDiagnostics(env, request, ctx, claims);
      }
      // Per-file delivery (MS2-FR-6): the grant token IS the authorization — no
      // session needed here (grants are minted only to authenticated, entitled
      // sessions below, and expire in minutes).
      if (request.method === "GET" && route === "media" && sub === "file") {
        const kind = parts[3] || "";
        const hash = (parts[4] || "").toLowerCase();
        return await serveFile(env, ctx, kind, hash,
                               url.searchParams.get("e"), url.searchParams.get("g"), nowSeconds());
      }
      // Batch grants (MS2-FR-6): entitlement checked per file against the catalog.
      if (request.method === "POST" && route === "media" && sub === "grants") {
        const claims = await requireSession(env, request);
        if (!(await rateLimit(env, `mediagrants:${rateSubjectKey(claims, ip)}`, 30, 600, nowSeconds()))) {
          throw new HttpError(429, "rate limited");
        }
        const body = await request.json<{ ids?: unknown }>().catch(() => ({} as { ids?: unknown }));
        const allIds = Array.isArray(body.ids)
          ? body.ids.filter((x): x is string => typeof x === "string")
          : [];
        if (allIds.length === 0) throw new HttpError(400, "no ids");
        // M16: resolve grants against the channel the caller is on (beta clients hold the
        // beta catalog); same query param the channel/catalog routes use.
        const grantChannel = url.searchParams.get("channel") === "beta" ? "beta" : "live";
        // LOW L16: don't silently drop ids past the cap — reject so the client splits/retries
        // instead of getting files that are neither granted nor denied.
        if (allIds.length > GRANTS_MAX_IDS) throw new HttpError(400, `too many ids (max ${GRANTS_MAX_IDS})`);
        const result = await issueGrants(env, scopeOf(claims), allIds, nowSeconds(), grantChannel);
        console.log(JSON.stringify({ evt: "MEDIATRACE grants", n: result.grants.length, denied: result.denied.length }));
        return json(result);
      }
      // ---- Media v2 (MS2-FR-3/20): channel manifests + immutable catalogs ----
      // The channel manifest is a small pointer set (media/channels/<live|beta>.json);
      // catalogs are immutable content-suffixed objects, served with long cache
      // lifetimes keyed by their own key. Catalog METADATA is served to any
      // authenticated session (entries carry the free flag; the byte-level paywall
      // stays on packs/files, same doctrine as search's whole-vocabulary teaser).
      if (request.method === "GET" && route === "media" && sub === "channel") {
        const claims = await requireSession(env, request);
        if (!(await rateLimit(env, `mediachannel:${rateSubjectKey(claims, ip)}`, 60, 600, nowSeconds()))) {
          throw new HttpError(429, "rate limited");
        }
        if (!env.MEDIA) throw new HttpError(503, "media storage not configured");
        const channel = url.searchParams.get("channel") === "beta" ? "beta" : "live";
        const obj = await env.MEDIA.get(`media/channels/${channel}.json`);
        if (!obj) throw new HttpError(404, "channel not published");
        return new Response(await obj.text(), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
        });
      }
      if (request.method === "GET" && route === "media" && sub === "catalog") {
        const claims = await requireSession(env, request);
        if (!(await rateLimit(env, `mediacatalog:${rateSubjectKey(claims, ip)}`, 60, 600, nowSeconds()))) {
          throw new HttpError(429, "rate limited");
        }
        if (!env.MEDIA) throw new HttpError(503, "media storage not configured");
        // Immutable fetch-by-key (MS2-FR-3, audit MEDIA-004): the client pins the catalog
        // world it read in ITS manifest by asking for that exact content-addressed object —
        // a publish landing mid-refresh can no longer swap the bytes under it. The key stays
        // inside the catalog prefix (no traversal, no probing other prefixes).
        if ((parts[3] || "") === "object") {
          const suffix = parts.slice(4).join("/");
          if (!suffix || suffix.includes("..") || !/^[A-Za-z0-9._/-]{1,200}$/.test(suffix)) {
            throw new HttpError(400, "invalid catalog key");
          }
          const key = `media/catalog/${suffix}`;
          const cacheKey = new Request(`https://read-cache.internal/${key}`, { method: "GET" });
          const cache = caches.default;
          const hit = await cache.match(cacheKey);
          if (hit) return hit;
          const obj = await env.MEDIA.get(key);
          if (!obj) throw new HttpError(404, "no such catalog object");
          const response = new Response(await obj.text(), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=86400, immutable",
            },
          });
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return response;
        }
        const kind = (parts[3] || "").toLowerCase();
        if (!/^[a-z0-9]{1,20}$/.test(kind)) throw new HttpError(400, "invalid kind");
        const channel = url.searchParams.get("channel") === "beta" ? "beta" : "live";
        const chObj = await env.MEDIA.get(`media/channels/${channel}.json`);
        if (!chObj) throw new HttpError(404, "channel not published");
        const manifest = JSON.parse(await chObj.text()) as {
          catalogs?: Record<string, { key?: string; sha?: string }>;
        };
        const meta = manifest.catalogs?.[kind];
        // Defense-in-depth: the key must stay inside the catalog prefix.
        if (!meta?.key || !meta.key.startsWith("media/catalog/")) {
          throw new HttpError(404, "no such catalog");
        }
        const cacheKey = new Request(`https://read-cache.internal/${meta.key}`, { method: "GET" });
        const cache = caches.default;
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
        const obj = await env.MEDIA.get(meta.key);
        if (!obj) throw new HttpError(404, "catalog object missing");
        const response = new Response(await obj.text(), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            // Immutable content-suffixed object: cache hard; a new catalog is a NEW key.
            "Cache-Control": "public, max-age=86400, immutable",
            ...(meta.sha ? { ETag: `"${meta.sha}"` } : {}),
          },
        });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
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
      // Direct-from-storage delivery (MS-NFR-PERF-3): authorize, then hand the client a
      // short-lived presigned R2 URL instead of streaming the bytes through the worker.
      // Same auth, same scope enforcement, same rate budget as the streamed route.
      if (request.method === "GET" && route === "audio" && sub === "packurl") {
        const claims = await requireSession(env, request);
        if (!(await rateLimit(env, `audiopack:${rateSubjectKey(claims, ip)}`, 300, 600, nowSeconds()))) {
          throw new HttpError(429, "rate limited");
        }
        const name = parts.slice(3).join("/");
        if (!name) throw new HttpError(400, "missing pack name");
        const manifest = await loadManifest(env);
        const norm = normalizePackName(name);
        // Paywall: identical check to the streamed route — a grant is authorization.
        if (!allowedPacks(manifest, scopeOf(claims)).has(norm)) {
          throw new HttpError(403, "pack not available for this scope");
        }
        const url = await presignPackURL(env, manifest, norm);
        if (!url) throw new HttpError(503, "direct delivery not configured");
        console.log(JSON.stringify({ evt: "MEDIATRACE packurl", name: norm }));
        return json({ url, expiresSeconds: PACK_URL_TTL_SECONDS });
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

  // Daily retention sweep (settings.md ST-FR-FDBK-5). The write-path prune is the fast case;
  // THIS is the guarantee. "Deleted within 30 days" must not depend on another user happening
  // to send feedback — a quiet month would otherwise keep an address alive indefinitely.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        const erased = await purgeExpiredFeedbackContacts(env);
        if (erased > 0) console.log(JSON.stringify({ evt: "FEEDBACK_CONTACT_PURGE", erased }));
      } catch (err) {
        console.error("feedback contact purge failed", { err: String(err) });
      }
    })());
  },
};
