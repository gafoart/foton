export type EnvWithCors = {
  ALLOWED_CORS_ORIGINS?: string;
};

function parseAllowedOrigins(env: EnvWithCors): Set<string> {
  const raw = env.ALLOWED_CORS_ORIGINS?.trim() ?? "";
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  );
}

function pickAllowOrigin(request: Request, env: EnvWithCors): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = parseAllowedOrigins(env);
  if (allowed.size === 0) return null;
  if (allowed.has(origin)) return origin;
  // Wildcard subdomain match: "https://*.example.com" matches "https://foo.example.com"
  for (const pattern of allowed) {
    if (!pattern.includes("*")) continue;
    const regex = new RegExp(
      "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]+") + "$"
    );
    if (regex.test(origin)) return origin;
  }
  return null;
}

export function corsPreflightHeaders(request: Request, env: EnvWithCors): Headers {
  const h = new Headers();
  const allowOrigin = pickAllowOrigin(request, env);
  if (allowOrigin) {
    h.set("Access-Control-Allow-Origin", allowOrigin);
    h.set("Access-Control-Allow-Credentials", "true");
  }
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

export function withCors(request: Request, env: EnvWithCors, response: Response): Response {
  const allowOrigin = pickAllowOrigin(request, env);
  if (!allowOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * For public GET bodies (e.g. manifest JSON) so a cross-origin editor can read without
 * ALLOWED_CORS_ORIGINS. Uses * only when no explicit allow-list origin matches.
 * Do not use for credentialed POST responses.
 */
export function withCorsAllowAnonymousRead(
  request: Request,
  env: EnvWithCors,
  response: Response
): Response {
  const allowOrigin = pickAllowOrigin(request, env);
  const headers = new Headers(response.headers);
  if (allowOrigin) {
    headers.set("Access-Control-Allow-Origin", allowOrigin);
    headers.set("Access-Control-Allow-Credentials", "true");
  } else {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
