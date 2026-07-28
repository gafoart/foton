/**
 * Google OAuth helpers + email-domain allow-list.
 *
 * Env contract:
 *   - GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET — Google Cloud →
 *     APIs & Services → Credentials → OAuth client (Web). Authorized
 *     redirect URI: `<origin>/auth/callback`.
 *   - ALLOWED_EMAIL_DOMAINS — comma-separated. Defaults to the two domains
 *     in the spec when unset; explicit override wins.
 *   - SESSION_SIGNING_SECRET — 32+ byte random string for HMAC.
 */

export interface OAuthEnv {
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  SESSION_SIGNING_SECRET?: string;
}

const DEFAULT_ALLOWED_DOMAINS = ["apbgroup.net", "gafoart.com"];

export function parseAllowedDomains(env: OAuthEnv): string[] {
  const raw = env.ALLOWED_EMAIL_DOMAINS?.trim();
  if (!raw) return DEFAULT_ALLOWED_DOMAINS;
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function isEmailAllowed(email: string, env: OAuthEnv): boolean {
  const domain = email.toLowerCase().split("@")[1] ?? "";
  return parseAllowedDomains(env).includes(domain);
}

export function isGoogleConfigured(env: OAuthEnv): boolean {
  return (
    !!env.GOOGLE_OAUTH_CLIENT_ID?.trim() &&
    !!env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()
  );
}

export function isOAuthConfigured(env: OAuthEnv): boolean {
  return isGoogleConfigured(env) && !!env.SESSION_SIGNING_SECRET?.trim();
}

export interface StateData {
  next: string;
  csrf: string;
}

export function encodeState(data: StateData): string {
  return btoa(JSON.stringify(data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeState(raw: string): StateData | null {
  try {
    let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const parsed = JSON.parse(atob(b64));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.next !== "string" ||
      typeof parsed.csrf !== "string"
    ) {
      return null;
    }
    return { next: parsed.next, csrf: parsed.csrf };
  } catch {
    return null;
  }
}

/**
 * Restrict the `next` destination to same-origin paths so a crafted login
 * link can't redirect the user off-site after a successful sign-in.
 */
export function sanitizeNextPath(next: string | null | undefined): string {
  if (!next || typeof next !== "string") return "/product";
  /** Normalize backslashes first — WHATWG browsers treat `/\host` as `//host`. */
  const normalized = next.replace(/\\/g, "/");
  if (!normalized.startsWith("/") || normalized.startsWith("//")) return "/product";
  /** Reserve `/auth/*` so successful login doesn't bounce back to the gate. */
  if (normalized.startsWith("/auth/")) return "/product";
  return normalized;
}

export function buildGoogleAuthUrl(
  env: OAuthEnv,
  origin: string,
  state: string
): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID!);
  url.searchParams.set("redirect_uri", `${origin}/auth/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
}

export interface GoogleUserInfo {
  email: string;
  verified_email: boolean;
  name?: string;
}

export async function exchangeGoogleCode(
  env: OAuthEnv,
  origin: string,
  code: string
): Promise<GoogleTokenResponse | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: `${origin}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    console.error("[oauth] google token exchange failed:", res.status, await res.text());
    return null;
  }
  return res.json();
}

export async function fetchGoogleUserInfo(
  accessToken: string
): Promise<GoogleUserInfo | null> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    console.error("[oauth] google userinfo failed:", res.status);
    return null;
  }
  return res.json();
}
