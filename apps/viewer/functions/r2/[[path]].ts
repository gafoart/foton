/**
 * Streams R2 splats through the viewer origin so Cloudflare's edge cache
 * fronts them. With the public r2.dev URL there is no CDN caching, which is
 * the main load-time bottleneck. This proxy gives:
 *   - Cache-Control: public, immutable → caches.default + browser cache
 *   - Same-origin (no CORP/COEP risk; no CORS preflight on cross-origin fetch)
 */
type Env = {
  SPLATS_R2: R2Bucket;
};

/**
 * Bump when an R2 object is replaced in-place to force every Worker-cache
 * entry to orphan in one shot. Cache keys include this suffix, so changing
 * the version means the next request misses caches.default and re-fetches
 * from R2. Increment freely; old entries simply age out and get evicted.
 */
const CACHE_VERSION = "v8";

/**
 * 1 hour at edge + browser. Previously `immutable, max-age=31536000`, which
 * meant a year of staleness when files were replaced in R2 in place — there
 * was no propagation path short of a manual purge or a Pages redeploy with a
 * different cache key. 1 h is a reasonable upper bound on "I just swapped a
 * splat and want to see it" while still amortising the CF -> R2 hop for the
 * overwhelming majority of requests.
 */
const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

function parseRangeHeader(
  range: string,
  size: number
): { offset: number; length: number } | null {
  const m = /^bytes=(\d+)-(\d+)?$/.exec(range.trim());
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null;
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env, params, waitUntil } = ctx;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const raw = params.path;
  const segments = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const key = segments.map((s) => decodeURIComponent(s)).join("/");
  if (!key) return new Response("Not found", { status: 404 });

  const cache = caches.default;
  /**
   * Strip Range header from the cache key so partial requests share the
   * same edge entry, and append CACHE_VERSION as a synthetic query param
   * so bumping the constant orphans every existing entry without touching
   * code paths. URL fragments are stripped by `new Request()` so they
   * can't serve as a key disambiguator.
   */
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set("__v", CACHE_VERSION);
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

  const rangeHeader = request.headers.get("range");
  const ifNoneMatch = request.headers.get("if-none-match");

  // Fast path: full-file cache hit.
  if (!rangeHeader) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      if (ifNoneMatch && ifNoneMatch === hit.headers.get("etag")) {
        return new Response(null, { status: 304, headers: hit.headers });
      }
      if (request.method === "HEAD") {
        return new Response(null, { status: hit.status, headers: hit.headers });
      }
      return hit;
    }
  }

  // For HEAD we don't need the body. For Range we'll fetch the requested slice.
  if (request.method === "HEAD") {
    const head = await env.SPLATS_R2.head(key);
    if (!head) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    head.writeHttpMetadata(headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
    headers.set("content-length", String(head.size));
    headers.set("etag", head.httpEtag);
    headers.set("cache-control", CACHE_CONTROL);
    headers.set("accept-ranges", "bytes");
    return new Response(null, { status: 200, headers });
  }

  let r2opts: R2GetOptions = {};
  let isRange = false;
  let totalSize = 0;

  if (rangeHeader) {
    const head = await env.SPLATS_R2.head(key);
    if (!head) return new Response("Not found", { status: 404 });
    totalSize = head.size;
    const parsed = parseRangeHeader(rangeHeader, totalSize);
    if (!parsed) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${totalSize}` },
      });
    }
    r2opts = { range: parsed };
    isRange = true;
  }

  const obj = await env.SPLATS_R2.get(key, r2opts);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", CACHE_CONTROL);
  headers.set("accept-ranges", "bytes");

  if (isRange && obj.range && totalSize > 0) {
    const start = (obj.range as { offset: number }).offset;
    const length =
      (obj.range as { length?: number }).length ?? totalSize - start;
    const end = start + length - 1;
    headers.set("content-range", `bytes ${start}-${end}/${totalSize}`);
    headers.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set("content-length", String(obj.size));
  const response = new Response(obj.body, { status: 200, headers });

  // Cache full responses only. Range responses share the same cache key, so
  // skipping cache.put for partials keeps the entry consistent.
  if (!isRange) {
    waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
};
