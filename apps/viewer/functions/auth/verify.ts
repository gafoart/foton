import { sanitizeNextPath, type OAuthEnv } from "../lib/oauth.js";
import { buildSessionCookie } from "../lib/session.js";
import {
  consumeVerificationToken,
  getUser,
  putUser,
  type UsersEnv,
} from "../lib/users.js";

type Env = OAuthEnv & UsersEnv;

function redirectToLogin(origin: string, params: Record<string, string>): Response {
  const url = new URL(`${origin}/auth/login`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const next = sanitizeNextPath(url.searchParams.get("next"));

  if (!env.MANIFEST_KV) {
    return redirectToLogin(url.origin, { error: "Servicio no disponible", next });
  }
  if (!token) {
    return redirectToLogin(url.origin, { error: "Token faltante", next });
  }

  const email = await consumeVerificationToken(env.MANIFEST_KV, token);
  if (!email) {
    return redirectToLogin(url.origin, {
      error: "El enlace de verificación venció o no es válido. Regístrate de nuevo para recibir uno nuevo.",
      next,
    });
  }

  const user = await getUser(env.MANIFEST_KV, email);
  if (!user) {
    return redirectToLogin(url.origin, { error: "No encontramos la cuenta", next });
  }

  if (user.status !== "active") {
    user.status = "active";
    user.activatedAt = Math.floor(Date.now() / 1000);
    await putUser(env.MANIFEST_KV, user);
  }

  /**
   * If the session secret is configured, sign the user in immediately on
   * verification — saves them from a second login round-trip and matches
   * what most product flows do (you just proved control of the inbox).
   */
  const secret = env.SESSION_SIGNING_SECRET?.trim();
  if (secret) {
    const cookie = await buildSessionCookie(user.email, secret);
    return new Response(null, {
      status: 302,
      headers: {
        Location: next,
        "Set-Cookie": cookie,
        "Cache-Control": "no-store",
      },
    });
  }

  return redirectToLogin(url.origin, { verified: "1", next });
};
