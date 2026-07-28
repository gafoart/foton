import { corsPreflightHeaders, type EnvWithCors } from "./lib/cors.js";
import { isEmailAllowed, type OAuthEnv } from "./lib/oauth.js";
import { clearSessionCookie, verifySession } from "./lib/session.js";

type Env = EnvWithCors & OAuthEnv;

/**
 * Paths that require a signed session cookie. The match is exact for the
 * pretty URL (e.g. `/product`) and prefix-based for any sub-route or the
 * `.html` form (`/product.html`, `/ia.html`) so the gate can't be bypassed.
 */
const PROTECTED_PREFIXES = ["/product", "/ia"];

function pathIsProtected(pathname: string): boolean {
  for (const prefix of PROTECTED_PREFIXES) {
    if (pathname === prefix) return true;
    if (pathname === `${prefix}.html`) return true;
    if (pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);

  /** Existing API CORS preflight. */
  if (url.pathname.startsWith("/api/")) {
    if (context.request.method === "OPTIONS") {
      const h = corsPreflightHeaders(context.request, context.env);
      if (!h.get("Access-Control-Allow-Origin")) {
        h.set("Access-Control-Allow-Origin", "*");
      }
      return new Response(null, { status: 204, headers: h });
    }
    return context.next();
  }

  /**
   * Gate the admin pages. When `SESSION_SIGNING_SECRET` is unset the gate
   * falls open — this keeps local `wrangler pages dev` usable without
   * provisioning OAuth credentials. Production deploys should always have
   * the secret configured.
   */
  if (pathIsProtected(url.pathname)) {
    const secret = context.env.SESSION_SIGNING_SECRET?.trim();
    if (secret) {
      const session = await verifySession(context.request, secret);
      const next = encodeURIComponent(url.pathname + url.search);
      if (!session) {
        return Response.redirect(`${url.origin}/auth/login?next=${next}`, 302);
      }
      /**
       * Re-validate the email domain on every request so removing a domain
       * from ALLOWED_EMAIL_DOMAINS takes effect immediately instead of
       * waiting for the 7-day cookie to expire. The cookie's HMAC signature
       * only guarantees the email wasn't tampered with — not that it's still
       * authorized.
       */
      if (!isEmailAllowed(session.email, context.env)) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/auth/login?next=${next}&error=${encodeURIComponent("Tu correo ya no está autorizado")}`,
            "Set-Cookie": clearSessionCookie(),
            "Cache-Control": "no-store",
          },
        });
      }
    }
  }

  return context.next();
};
