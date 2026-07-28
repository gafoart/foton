import { clearSessionCookie } from "../lib/session.js";
import { sanitizeNextPath } from "../lib/oauth.js";

export const onRequestGet: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  /** Default back to the login page so the user can immediately sign in again. */
  const next = url.searchParams.get("next");
  const target = next
    ? `/auth/login?next=${encodeURIComponent(sanitizeNextPath(next))}`
    : "/auth/login";

  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      "Set-Cookie": clearSessionCookie(),
      "Cache-Control": "no-store",
    },
  });
};
