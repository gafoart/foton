function envString(key: string): string | undefined {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  return env[key];
}

/**
 * Base URL of the deployed viewer (showroom), no trailing slash.
 * Set in the editor as VITE_VIEWER_API_ORIGIN so save/load/draft hit the viewer's API (e.g. Cloudflare Pages Functions).
 */
export function viewerApiBaseUrl(): string {
  const v = envString("VITE_VIEWER_API_ORIGIN");
  if (typeof v !== "string" || !v.trim()) return "";
  return v.replace(/\/$/, "");
}

export function useRemoteManifestApi(): boolean {
  return viewerApiBaseUrl().length > 0;
}

/**
 * Optional Bearer token for POST /api/* when the Access session cookie is not sent (cross-origin editor).
 * Prefer same-origin deployment + Cloudflare Access so this is unnecessary.
 */
export function manifestSaveSecret(): string {
  const s = envString("VITE_MANIFEST_SAVE_SECRET");
  return typeof s === "string" ? s : "";
}

/**
 * GET /api/manifest (and similar public reads). Omits credentials so responses may use
 * Access-Control-Allow-Origin: * from the viewer when ALLOWED_CORS_ORIGINS is unset.
 */
export function manifestReadFetchInit(extra?: RequestInit): RequestInit {
  return {
    credentials: "omit",
    ...extra,
    headers: extra?.headers,
  };
}

export function manifestAuthFetchInit(extra?: RequestInit): RequestInit {
  const headers = new Headers(extra?.headers);
  const secret = manifestSaveSecret();
  if (secret) {
    headers.set("Authorization", `Bearer ${secret}`);
  }
  return {
    ...extra,
    credentials: "include",
    headers,
  };
}
