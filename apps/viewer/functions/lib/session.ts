import { isEmailAllowed, type OAuthEnv } from "./oauth.js";

/**
 * Stateless session cookies for the showroom admin pages.
 *
 * Cookie format: `<payload-b64url>.<hmac-b64url>` where payload is JSON
 * `{ email, iat, exp }`. HMAC-SHA-256 over the payload bytes with a server
 * secret seals the cookie — there is no DB; the cookie itself is the
 * session. Clearing happens by setting `Max-Age=0`.
 *
 * Threat model: prevents tampering by clients (so an attacker can't change
 * `email` to a whitelisted domain). The signing secret must be kept server-
 * side only; rotate it to invalidate every issued cookie at once.
 */

const COOKIE_NAME = "showroom_session";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

export interface SessionPayload {
  email: string;
  /** Issued at — seconds since epoch */
  iat: number;
  /** Expires at — seconds since epoch */
  exp: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSign(secret: string, payloadBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  /** TS 5.7+ `Uint8Array<ArrayBufferLike>` doesn't unify with `BufferSource`; cast is safe for locally-allocated bytes. */
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes as BufferSource);
  return new Uint8Array(sig);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function buildSessionCookie(email: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { email, iat: now, exp: now + COOKIE_MAX_AGE };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await hmacSign(secret, payloadBytes);
  const value = `${bytesToBase64Url(payloadBytes)}.${bytesToBase64Url(sig)}`;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export async function verifySession(
  request: Request,
  secret: string
): Promise<SessionPayload | null> {
  const raw = readCookie(request, COOKIE_NAME);
  if (!raw) return null;
  const [payloadB64, sigB64] = raw.split(".");
  if (!payloadB64 || !sigB64) return null;
  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = base64UrlToBytes(payloadB64);
    sigBytes = base64UrlToBytes(sigB64);
  } catch {
    return null;
  }
  const expected = await hmacSign(secret, payloadBytes);
  if (!constantTimeEqual(sigBytes, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof payload.email !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/**
 * Same-origin guard for state-changing endpoints. SameSite=Lax cookies are
 * still sent on top-level POSTs initiated by another site (form submits),
 * so for any write endpoint we additionally require the request to have
 * come from our own origin. Falls back to Referer when Origin is absent,
 * and rejects when neither header is present — most browsers send at least
 * one, and non-browser clients can supply the header explicitly.
 */
export function isSameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin) return origin === url.origin;
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === url.origin;
  } catch {
    return false;
  }
}

/**
 * Auth check for the showroom write APIs (e.g. `/api/knowledge/*`). Combines:
 *   - HMAC-signed session cookie (proves the user signed in via /auth/login)
 *   - Email-domain allow-list (proves the email still belongs to an
 *     authorized tenant — supports immediate-effect revocation)
 *
 * Returns `{ ok, email }` on success or `{ ok:false, status, message }` on
 * failure. Matches the shape of `verifyEditorAuth` so callers can swap
 * implementations without restructuring the response code.
 */
export type EditorSessionResult =
  | { ok: true; email: string }
  | { ok: false; status: number; message: string };

export async function verifyEditorSession(
  request: Request,
  env: OAuthEnv
): Promise<EditorSessionResult> {
  const secret = env.SESSION_SIGNING_SECRET?.trim();
  if (!secret) {
    return {
      ok: false,
      status: 503,
      message: "Auth no configurado en el servidor (SESSION_SIGNING_SECRET missing)",
    };
  }
  const session = await verifySession(request, secret);
  if (!session) {
    return {
      ok: false,
      status: 401,
      message: "Sesión inválida o expirada. Vuelve a iniciar sesión.",
    };
  }
  if (!isEmailAllowed(session.email, env)) {
    return {
      ok: false,
      status: 403,
      message: "Tu correo ya no está autorizado para editar.",
    };
  }
  return { ok: true, email: session.email };
}
