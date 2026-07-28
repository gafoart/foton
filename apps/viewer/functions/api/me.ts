import { verifySession } from "../lib/session.js";
import type { OAuthEnv } from "../lib/oauth.js";

type Env = OAuthEnv;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Lightweight identity endpoint for the admin pages. Returns the email
 * encoded in the session cookie so the UI can show "Signed in as …" + a
 * logout link. When auth isn't configured (local dev with no secret) it
 * returns `{ enabled: false }` and clients skip the chrome.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const secret = context.env.SESSION_SIGNING_SECRET?.trim();
  if (!secret) return json({ enabled: false });
  const session = await verifySession(context.request, secret);
  if (!session) return json({ enabled: true, signedIn: false });
  return json({ enabled: true, signedIn: true, email: session.email });
};
