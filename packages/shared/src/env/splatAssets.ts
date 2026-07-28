function envString(key: string): string | undefined {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  return env[key];
}

/**
 * Public base URL for heavy splat assets (e.g. R2 public bucket), no trailing slash.
 * When set, `/splats/...` paths resolve to this origin for fetch/Spark URL loads.
 */
export function publicAssetsBaseUrl(): string {
  const v = envString("VITE_PUBLIC_ASSETS_BASE");
  if (typeof v !== "string" || !v.trim()) return "";
  return v.replace(/\/$/, "");
}

/**
 * Resolve manifest asset paths for splats. Absolute http(s) URLs pass through.
 * With VITE_PUBLIC_ASSETS_BASE, only paths under `/splats/` are prefixed (thumbnails etc. stay on Pages).
 */
/**
 * Build-time cache-bust token. Forces CDN/browser to re-fetch splat assets
 * after each deploy so updated .sog files aren't served stale.
 */
const ASSET_CACHE_BUST = envString("VITE_ASSET_CACHE_BUST") ?? "";

export function resolveSplatAssetUrl(pathOrUrl: string): string {
  const u = pathOrUrl.trim();
  if (/^https?:\/\//i.test(u)) return u;
  const base = publicAssetsBaseUrl();
  const path = u.startsWith("/") ? u : `/${u}`;
  const resolved = base && path.startsWith("/splats/") ? `${base}${path}` : (u.startsWith("/") ? u : path);
  if (ASSET_CACHE_BUST) return `${resolved}${resolved.includes("?") ? "&" : "?"}v=${ASSET_CACHE_BUST}`;
  return resolved;
}
