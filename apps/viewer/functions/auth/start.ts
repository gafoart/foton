import {
  buildGoogleAuthUrl,
  encodeState,
  isOAuthConfigured,
  sanitizeNextPath,
  type OAuthEnv,
} from "../lib/oauth.js";

type Env = OAuthEnv;

const OAUTH_STATE_COOKIE = "showroom_oauth_state";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!isOAuthConfigured(env)) {
    return Response.redirect(`${url.origin}/auth/login?error=${encodeURIComponent("Auth not configured")}`, 302);
  }

  const next = sanitizeNextPath(url.searchParams.get("next"));
  const csrf = crypto.randomUUID();
  const state = encodeState({ next, csrf });

  /**
   * Mirror the CSRF token in a short-lived cookie. On the callback we
   * compare it against the `state` value Google echoes back — defends
   * against a forged login URL that pins the user to an attacker-chosen
   * `next` or replays an old code.
   */
  const cookie = `${OAUTH_STATE_COOKIE}=${csrf}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
  const authUrl = buildGoogleAuthUrl(env, url.origin, state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
    },
  });
};
