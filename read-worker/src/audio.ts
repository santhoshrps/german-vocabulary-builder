// Audio media: serve the pack manifest and the pack blobs from R2.
//
// The build pipeline (sync/audio_sync.py) writes everything to the MEDIA bucket:
//   audio/manifest.json          — { version, packs:{name:{hash,bytes,count}}, scopes:{free,full} }
//   audio/packs/<name>.pack      — custom container of that group's MP3s
//
// This worker only READS. Scope enforcement reuses the manifest's own `scopes`
// map: a free session may only see/fetch the "free" pack; a full session gets
// the per-type/level packs. Nothing here queries D1 — the manifest is the source
// of truth for what audio exists and who may download it.

import { Env } from "./env";
import { Scope } from "./entitlement";
import { HttpError } from "./http";

export interface AudioManifest {
  version: string;
  // `hash`: content-identity (id:audio_hash) for diffing. `sha`: digest of the actual
  // .pack blob, for client-side integrity verification of the downloaded bytes.
  packs: Record<string, { hash: string; sha?: string; bytes: number; count: number; key?: string }>;
  scopes: Record<string, string[]>;
}

// Cache the parsed manifest per isolate keyed by version is unnecessary; R2
// reads are cheap and the responses we build are edge-cached by version anyway.
export async function loadManifest(env: Env): Promise<AudioManifest> {
  if (!env.MEDIA) throw new HttpError(503, "media storage not configured");
  const obj = await env.MEDIA.get("audio/manifest.json");
  if (!obj) throw new HttpError(404, "audio manifest not found");
  const parsed = (await obj.json()) as Partial<AudioManifest>;
  if (!parsed.version || !parsed.packs || !parsed.scopes) {
    throw new HttpError(500, "audio manifest malformed");
  }
  return parsed as AudioManifest;
}

// The pack names a given scope is allowed to see/download.
export function allowedPacks(manifest: AudioManifest, scope: Scope): Set<string> {
  return new Set(manifest.scopes[scope] ?? []);
}

// Manifest filtered to the caller's scope: they only learn about packs they may
// fetch, and `version` stays scope-qualified so a free->full upgrade re-syncs.
export function scopedManifest(manifest: AudioManifest, scope: Scope): AudioManifest {
  const allowed = allowedPacks(manifest, scope);
  const packs: AudioManifest["packs"] = {};
  for (const name of allowed) {
    if (manifest.packs[name]) packs[name] = manifest.packs[name];
  }
  return {
    version: `${manifest.version}:${scope}`,
    packs,
    scopes: { [scope]: [...allowed] },
  };
}

// Validate and normalize a requested pack name from the URL path. Names are
// "free" or "<type>s/<level>" (e.g. "nouns/a1.1") — restrict the charset so the
// value can never escape the audio/packs/ prefix. Dots in the second segment are
// allowed only BETWEEN alphanumeric runs (defense-in-depth: "nouns/.." matched the
// old character-class form; not exploitable — manifest allowlist + flat R2 keys —
// but there is no reason to admit it).
export function normalizePackName(raw: string): string {
  const name = decodeURIComponent(raw).trim();
  if (!/^[a-z0-9]+(\/[a-z0-9]+(\.[a-z0-9]+)*)?$/.test(name)) {
    throw new HttpError(400, "invalid pack name");
  }
  return name;
}

// Object key for a pack: v2 manifests carry an immutable content-suffixed `key`
// (audio/packs/<name>-<sha12>.pack — promote/rollback are pointer swaps, objects
// are never overwritten); legacy manifests fall back to the name-derived path.
// Defense-in-depth: a manifest key must stay inside the packs prefix.
function packKey(manifest: AudioManifest, name: string): string {
  const key = manifest.packs[name]?.key;
  if (key && key.startsWith("audio/packs/")) return key;
  return `audio/packs/${name}.pack`;
}

// Returns the R2 object for a pack the caller is entitled to, or throws.
export async function getPackObject(
  env: Env,
  manifest: AudioManifest,
  scope: Scope,
  name: string
): Promise<R2ObjectBody> {
  if (!allowedPacks(manifest, scope).has(name)) {
    throw new HttpError(403, "pack not available for this scope");
  }
  if (!env.MEDIA) throw new HttpError(503, "media storage not configured");
  const obj = await env.MEDIA.get(packKey(manifest, name));
  if (!obj) throw new HttpError(404, "pack not found");
  return obj;
}

// ---------------------------------------------------------------------------
// Direct-from-storage delivery (MS-NFR-PERF-3): presigned R2 GET URLs
//
// The worker used to STREAM every pack body (client → worker → R2 and back),
// which put the worker runtime in the byte path and paced every stream.
// Instead the worker now only AUTHORIZES: scope-check the pack, then mint a
// short-lived S3-SigV4 presigned URL for the exact object, and let the client
// pull the bytes straight from R2. The paywall is intact — the URL is minted
// per authenticated request, names one object, and expires in minutes.
// Query-presign per AWS SigV4 (region "auto", service "s3", UNSIGNED-PAYLOAD);
// implemented on crypto.subtle — no dependencies.
// ---------------------------------------------------------------------------

/// Seconds a minted pack URL stays valid. Long enough for the slowest retry of
/// the biggest pack on a bad network; short enough that a leaked URL is stale
/// before it can be meaningfully shared.
export const PACK_URL_TTL_SECONDS = 600;

function hexOf(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  return hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw", key instanceof Uint8Array ? key.buffer as ArrayBuffer : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
}

// RFC 3986 strict encoding for SigV4 query values (encodeURIComponent plus the
// characters it leaves bare that SigV4 requires encoded).
function awsEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/// Mints a presigned GET URL for one pack object, or null when presigning
/// isn't configured (missing account/bucket/token env) — callers then fall
/// back to the streamed route.
export async function presignPackURL(env: Env, manifest: AudioManifest, name: string): Promise<string | null> {
  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_MEDIA_BUCKET;
  const accessKey = env.R2_ACCESS_KEY_ID;
  const secret = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKey || !secret) return null;

  const host = `${accountId}.r2.cloudflarestorage.com`;
  // Key segments are [a-z0-9.]+ (see normalizePackName), so encoding is identity —
  // but encode per-segment anyway so a future name rule can't silently break signing.
  const key = packKey(manifest, name);
  const canonicalUri = `/${bucket}/` + key.split("/").map(awsEncode).join("/");

  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");            // YYYYMMDD
  const datetime = date + "T" + now.toISOString().slice(11, 19).replace(/:/g, "") + "Z";
  const scope = `${date}/auto/s3/aws4_request`;

  const params: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKey}/${scope}`],
    ["X-Amz-Date", datetime],
    ["X-Amz-Expires", String(PACK_URL_TTL_SECONDS)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = params
    .map(([k, v]) => `${awsEncode(k)}=${awsEncode(v)}`)
    .sort()
    .join("&");

  const canonicalRequest = [
    "GET", canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256", datetime, scope, await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(new TextEncoder().encode("AWS4" + secret), date);
  const kRegion = await hmac(kDate, "auto");
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hexOf(await hmac(kSigning, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
