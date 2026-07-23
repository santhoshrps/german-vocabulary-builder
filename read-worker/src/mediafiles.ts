// Per-file media delivery (MS2-FR-6, tracker #9): batch grants + streamed files.
//
// WHY GRANTS: catalog METADATA is served to every session (the teaser doctrine),
// so a free user knows the content hashes of paid files — the BYTE paywall must
// therefore be enforced per file. The client asks for a batch of media ids; the
// worker checks each against the catalog (entitlement = full scope, or the
// entry's free flag) and returns short-lived signed tokens. The file route serves
// bytes only with a valid token. Content-addressed masters (audio/files/<hash>,
// image/files/<hash>) are immutable, so authorized responses cache hard at the
// edge (authorize-then-share, the pack-serving doctrine).
//
// SELF-HEAL (MS2-FR-6): tokens expire in minutes; the client treats 401/410 on a
// file fetch as "grant expired", re-requests the batch, and continues — never a
// user-visible error.

import { Env } from "./env";
import { HttpError } from "./http";
import { utf8, bytesToHex, bytesToB64Url, b64UrlToBytes, timingSafeEqualBytes } from "./bytes";

export const GRANT_TTL_SECONDS = 600;
export const GRANTS_MAX_IDS = 500;

interface CatalogIndexEntry {
  kind: "audio" | "image";
  hash: string;
  free: boolean;
  bytes: number;
}

// Per-isolate catalog index, keyed by channel + manifest version+generation. ~36k
// entries build in one pass over the two catalog objects; rebuilt only when the world
// version moves (or on isolate recycle). Keyed PER CHANNEL (M16): live and beta index
// separately, so a beta client's grants resolve against the beta catalog it holds.
const indexCacheByChannel: Record<string, { key: string; index: Map<string, CatalogIndexEntry> }> = {};

async function loadJSON<T>(env: Env, key: string): Promise<T | null> {
  if (!env.MEDIA) return null;
  const obj = await env.MEDIA.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as T;
  } catch {
    // A truncated/corrupt catalog or channel object is a clean 5xx, not an uncaught
    // 500 (LOW L17): callers surface a stable "media storage" error shape.
    throw new HttpError(502, "corrupt media metadata");
  }
}

interface ChannelManifestLite {
  version: string;
  generation: string;
  world?: string;
  catalogs?: Record<string, { key?: string }>;
}

/// The channel's WORLD identity (audit MEDIA-001): the publisher's canonical digest when
/// present; version:generation for pre-migration worlds.
export function worldOf(manifest: ChannelManifestLite): string {
  return manifest.world ?? `${manifest.version}:${manifest.generation}`;
}

async function loadChannel(env: Env, channel: "live" | "beta"): Promise<ChannelManifestLite> {
  // L20: match the other media routes' shape — an unbound MEDIA binding is a 503
  // "not configured", not a 404 "no channel" (a 404 wrongly reads as "this channel
  // isn't published" when the real cause is missing storage config).
  if (!env.MEDIA) throw new HttpError(503, "media storage not configured");
  const manifest = await loadJSON<ChannelManifestLite>(env, `media/channels/${channel}.json`);
  if (!manifest) throw new HttpError(404, `no ${channel} media channel`);
  return manifest;
}

export async function catalogIndex(
  env: Env, channel: "live" | "beta" = "live", preloaded?: ChannelManifestLite
): Promise<Map<string, CatalogIndexEntry>> {
  const manifest = preloaded ?? (await loadChannel(env, channel));
  // Cache keyed by the FULL world identity (audit MEDIA-001): a catalog-only or
  // floor-only publish changes the world digest, so the isolate cache can no longer
  // serve a stale index for an unchanged pack-derived version.
  const cacheKey = worldOf(manifest);
  const cached = indexCacheByChannel[channel];
  if (cached?.key === cacheKey) return cached.index;

  const index = new Map<string, CatalogIndexEntry>();
  for (const shard of ["audio", "image"] as const) {
    const key = manifest.catalogs?.[shard]?.key;
    if (!key || !key.startsWith("media/catalog/")) continue;
    const catalog = await loadJSON<{ entries: { id: string; free: number; hash: string; bytes: number }[] }>(env, key);
    for (const e of catalog?.entries ?? []) {
      // Keyed by "<shard>:<id>", NEVER bare id: a word's audio entry and its image
      // entry share the same id, so a flat map would let the image overwrite the
      // audio (an audio grant request would be answered with the image — found
      // 2026-07-18 before any client shipped). Grant requests carry the same
      // composite form.
      index.set(`${shard}:${e.id}`, { kind: shard, hash: e.hash, free: e.free === 1, bytes: e.bytes });
    }
  }
  indexCacheByChannel[channel] = { key: cacheKey, index };
  return index;
}

// ---- Grant tokens -----------------------------------------------------------
// HMAC over "media-grant|kind|hash|exp" with the session secret (same trust
// domain, distinct context string so a grant can never pass as a session JWT).

async function grantMac(env: Env, kind: string, hash: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", utf8(env.SESSION_JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, utf8(`media-grant|${kind}|${hash}|${exp}`));
  return bytesToB64Url(new Uint8Array(mac));
}

export interface Grant {
  id: string;
  kind: string;
  hash: string;
  bytes: number;
  url: string;   // /v1/media/file/<kind>/<hash>?e=<exp>&g=<mac>
}

export async function issueGrants(
  env: Env, scope: "free" | "full", ids: string[], now: number,
  channel: "live" | "beta" = "live", expectedWorld?: string
): Promise<{ grants: Grant[]; denied: string[]; expiresSeconds: number }> {
  const manifest = await loadChannel(env, channel);
  // World precondition (audit MEDIA-001/002): when the caller states which world its
  // catalog truth came from, a moved pointer answers 409 stale_world — never a silent
  // resolution of the same ids against a NEWER catalog the caller has not seen.
  if (expectedWorld && expectedWorld !== worldOf(manifest)) {
    throw new HttpError(409, "stale_world");
  }
  const index = await catalogIndex(env, channel, manifest);
  const exp = now + GRANT_TTL_SECONDS;
  const grants: Grant[] = [];
  const denied: string[] = [];
  for (const id of ids) {
    // ids MUST be kind-composite ("audio:<id>" / "image:<id>") — the response echoes
    // the requested composite id so the client's matching stays exact.
    const entry = id.startsWith("audio:") || id.startsWith("image:") ? index.get(id) : undefined;
    if (!entry || (scope !== "full" && !entry.free)) {
      denied.push(id);
      continue;
    }
    const mac = await grantMac(env, entry.kind, entry.hash, exp);
    grants.push({
      id, kind: entry.kind, hash: entry.hash, bytes: entry.bytes,
      url: `/v1/media/file/${entry.kind}/${entry.hash}?e=${exp}&g=${mac}`,
    });
  }
  return { grants, denied, expiresSeconds: GRANT_TTL_SECONDS };
}

// ---- File serving -----------------------------------------------------------

// L15: a Map (not a plain object) so `kind` can't reach a prototype member
// ("constructor"/"toString") and slip past the allowlist as a truthy `ext`.
const FILE_EXT = new Map<string, string>([["audio", "m4a"], ["image", "heic"]]);
const FILE_CONTENT_TYPE: Record<string, string> = { audio: "audio/mp4", image: "image/heic" };

export async function serveFile(
  env: Env, ctx: ExecutionContext, kind: string, hash: string,
  expParam: string | null, macParam: string | null, now: number
): Promise<Response> {
  const ext = FILE_EXT.get(kind);
  if (!ext || !/^[0-9a-f]{16,64}$/.test(hash)) throw new HttpError(400, "invalid file reference");
  const exp = parseInt(expParam ?? "", 10);
  if (!exp || !macParam) throw new HttpError(401, "missing grant");
  // 410 (not 401) for a stale-but-wellformed grant: the client's self-heal signal.
  if (exp <= now) throw new HttpError(410, "grant expired");
  // M18: decode the client-supplied MAC inside a guard — b64UrlToBytes → atob throws on
  // malformed input, which unguarded 500s instead of the documented 401 (and pollutes
  // 5xx alerting with attacker-controllable noise).
  let providedMac: Uint8Array;
  try {
    providedMac = b64UrlToBytes(macParam);
  } catch {
    throw new HttpError(401, "invalid grant");
  }
  const expected = await grantMac(env, kind, hash, exp);
  if (!timingSafeEqualBytes(providedMac, b64UrlToBytes(expected))) {
    throw new HttpError(401, "invalid grant");
  }
  if (!env.MEDIA) throw new HttpError(503, "media storage not configured");

  const objectKey = `${kind}/files/${hash}.${ext}`;
  // Content-addressed → immutable: authorized requests share one edge-cached body.
  const cacheKey = new Request(`https://read-cache.internal/${objectKey}`, { method: "GET" });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const obj = await env.MEDIA.get(objectKey);
  if (!obj) {
    // L18: a granted object that isn't in R2 means the catalog referenced a hash the
    // pipeline never uploaded (M26/M27 now catch this at publish time — it should not
    // occur). Serve a SHORT-lived cached 404 so a client that retries doesn't hammer R2
    // on every playback, and log it for the operator. It stays a 404 (not 410, which is
    // the grant-expiry self-heal signal): the file is genuinely absent, not stale.
    console.log(JSON.stringify({ evt: "MEDIATRACE file-missing", kind, hash }));
    const miss = new Response(JSON.stringify({ error: "file not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    });
    ctx.waitUntil(cache.put(cacheKey, miss.clone()));
    return miss;
  }
  const response = new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": FILE_CONTENT_TYPE[kind],
      "Cache-Control": "public, max-age=86400, immutable",
      ETag: `"${hash}"`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
