// Edge caching keyed on the dataset version, NOT the caller's token.
//
// This is what makes D1-direct safe for 100–1000 concurrent users: every
// authorized caller shares one cached object per version, so the origin (D1) is
// queried roughly once per version per Cloudflare PoP instead of once per user.
// Auth is validated BEFORE we reach here, so unauthorized requests never get a
// cached body.

export interface CachedResult {
  body: string;
  contentType: string;
}

export async function serveCachedByVersion(
  request: Request,
  ctx: ExecutionContext,
  version: string,
  cacheTag: string,
  maxAge: number,
  build: () => Promise<CachedResult>
): Promise<Response> {
  const etag = `"${version}"`;

  // A client already on this version transfers nothing.
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  // Synthetic cache key: path + version only. Authorization header is excluded
  // so all users share the same cached entry.
  const url = new URL(request.url);
  const keyUrl = `https://read-cache.internal${url.pathname}?v=${version}&tag=${cacheTag}`;
  const cacheKey = new Request(keyUrl, { method: "GET" });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    // Re-attach the ETag for conditional requests.
    const headers = new Headers(hit.headers);
    headers.set("ETag", etag);
    headers.set("X-Cache", "HIT");
    return new Response(hit.body, { status: hit.status, headers });
  }

  const { body, contentType } = await build();
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": `public, max-age=${maxAge}`,
    ETag: etag,
    "X-Cache": "MISS",
  });
  const response = new Response(body, { status: 200, headers });
  // Store a clone in the edge cache without blocking the response.
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
