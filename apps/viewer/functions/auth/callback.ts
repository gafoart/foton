import {
  decodeState,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  isEmailAllowed,
  isOAuthConfigured,
  parseAllowedDomains,
  sanitizeNextPath,
  type OAuthEnv,
} from "../lib/oauth.js";
import { buildSessionCookie } from "../lib/session.js";

type Env = OAuthEnv;

const OAUTH_STATE_COOKIE = "showroom_oauth_state";

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function redirectWithError(origin: string, error: string, next: string): Response {
  const url = new URL(`${origin}/auth/login`);
  url.searchParams.set("error", error);
  url.searchParams.set("next", next);
  return Response.redirect(url.toString(), 302);
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!isOAuthConfigured(env)) {
    return redirectWithError(url.origin, "Auth no configurado", "/product");
  }

  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  if (!code || !stateRaw) {
    return redirectWithError(url.origin, "Respuesta inválida del proveedor", "/product");
  }

  const state = decodeState(stateRaw);
  if (!state) {
    return redirectWithError(url.origin, "Estado inválido", "/product");
  }

  const cookieCsrf = readCookie(request, OAUTH_STATE_COOKIE);
  if (!cookieCsrf || cookieCsrf !== state.csrf) {
    return redirectWithError(url.origin, "CSRF mismatch (vuelve a intentar)", state.next);
  }

  const tokens = await exchangeGoogleCode(env, url.origin, code);
  if (!tokens?.access_token) {
    return redirectWithError(url.origin, "No se pudo verificar la identidad", state.next);
  }

  const user = await fetchGoogleUserInfo(tokens.access_token);
  if (!user?.email || user.verified_email === false) {
    return redirectWithError(url.origin, "Correo no verificado por Google", state.next);
  }

  if (!isEmailAllowed(user.email, env)) {
    const domains = parseAllowedDomains(env).map((d) => `@${d}`).join(", ");
    return redirectWithError(
      url.origin,
      `El correo ${user.email} no está autorizado. Dominios permitidos: ${domains}.`,
      state.next
    );
  }

  const sessionCookie = await buildSessionCookie(user.email, env.SESSION_SIGNING_SECRET!);
  /** Clear the short-lived state cookie now that we've consumed it. */
  const clearState = `${OAUTH_STATE_COOKIE}=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie);
  headers.append("Set-Cookie", clearState);
  headers.set("Location", sanitizeNextPath(state.next));
  headers.set("Cache-Control", "no-store");

  return new Response(null, { status: 302, headers });
};
