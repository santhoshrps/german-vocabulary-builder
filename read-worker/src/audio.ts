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
  packs: Record<string, { hash: string; bytes: number; count: number }>;
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
// value can never escape the audio/packs/ prefix.
export function normalizePackName(raw: string): string {
  const name = decodeURIComponent(raw).trim();
  if (!/^[a-z0-9]+(\/[a-z0-9.]+)?$/.test(name)) {
    throw new HttpError(400, "invalid pack name");
  }
  return name;
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
  const obj = await env.MEDIA.get(`audio/packs/${name}.pack`);
  if (!obj) throw new HttpError(404, "pack not found");
  return obj;
}
