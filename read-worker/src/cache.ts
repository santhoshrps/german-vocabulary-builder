// Edge caching keyed on the dataset version, NOT the caller's token.
//
// This is what makes D1-direct safe for 100–1000 concurrent users: every
// authorized caller shares one cached object per version, so the origin (D1) is
// queried roughly once per version per Cloudflare PoP instead of once per user.
// Auth is validated BEFORE we reach here, so unauthorized requests never get a
// cached body.
//
// Bodies are stored and served GZIPPED (2026-07-12): the ~20 MB NDJSON snapshot is
// highly repetitive text that compresses ~5-8x, and its content type
// (application/x-ndjson) is not on Cloudflare's auto-compression list — it was going
// over the wire raw, dominating the words phase of every fresh install. Compression
// runs ONCE per version per PoP (the cache stores the compressed bytes); URLSession
// decompresses transparently, so no client change. A rare non-gzip client (debug
// curl without --compressed) gets the body inflated on the fly.

export interface CachedResult {
  body: string;
  contentType: string;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

async function gunzip(body: ReadableStream): Promise<ArrayBuffer> {
  return await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

function acceptsGzip(request: Request): boolean {
  return /\bgzip\b/.test(request.headers.get("Accept-Encoding") ?? "");
}

/// Serves a cached response honoring the caller's Accept-Encoding. Only bodies that
/// really carry `Content-Encoding: gzip` are ever inflated — entries cached by the
/// pre-compression worker (same version key!) are plain and pass through untouched,
/// and a rare non-gzip client (debug curl without --compressed) gets the body
/// inflated on the fly.
async function serveEncoded(hit: Response, request: Request, etag: string): Promise<Response> {
  const headers = new Headers(hit.headers);
  headers.set("ETag", etag);
  headers.set("X-Cache", hit.headers.get("X-Cache") ?? "HIT");
  const isGzipBody = hit.headers.get("Content-Encoding") === "gzip";
  if (!isGzipBody || acceptsGzip(request) || hit.body === null) {
    return new Response(hit.body, { status: hit.status, headers });
  }
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return new Response(await gunzip(hit.body), { status: hit.status, headers });
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
    return serveEncoded(hit, request, etag);
  }

  const { body, contentType } = await build();
  const compressed = await gzip(body);
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Encoding": "gzip",
    // The cached bytes are gzip; what leaves the edge depends on Accept-Encoding.
    Vary: "Accept-Encoding",
    "Cache-Control": `public, max-age=${maxAge}`,
    ETag: etag,
    "X-Cache": "MISS",
  });
  const response = new Response(compressed, { status: 200, headers });
  // Store a clone in the edge cache without blocking the response.
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return serveEncoded(response, request, etag);
}
