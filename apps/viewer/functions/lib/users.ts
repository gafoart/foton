/**
 * User records + verification tokens, persisted in MANIFEST_KV.
 *
 * Key layout (all values JSON unless noted):
 *   user:<email-lowercased>       → UserRecord
 *   verify:<token>                → { email } with 24h TTL
 *
 * Email is normalized to lowercase everywhere so the lookup is stable
 * regardless of how the user typed it during signup vs login.
 */

export interface UserRecord {
  email: string;
  passwordHash: string;
  status: "pending" | "active";
  createdAt: number;
  activatedAt?: number;
}

const USER_KEY_PREFIX = "user:";
const VERIFY_KEY_PREFIX = "verify:";
const VERIFY_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface UsersEnv {
  MANIFEST_KV?: KVNamespace;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function userKey(email: string): string {
  return `${USER_KEY_PREFIX}${normalizeEmail(email)}`;
}

function verifyKey(token: string): string {
  return `${VERIFY_KEY_PREFIX}${token}`;
}

export async function getUser(kv: KVNamespace, email: string): Promise<UserRecord | null> {
  const raw = await kv.get(userKey(email));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UserRecord;
    if (typeof parsed.email !== "string" || typeof parsed.passwordHash !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function putUser(kv: KVNamespace, user: UserRecord): Promise<void> {
  await kv.put(userKey(user.email), JSON.stringify(user));
}

/**
 * Generate a new verification token, store it in KV pointing to the email,
 * and return the token. Tokens are 32 random bytes base64url-encoded.
 */
export async function createVerificationToken(
  kv: KVNamespace,
  email: string
): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const token = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await kv.put(
    verifyKey(token),
    JSON.stringify({ email: normalizeEmail(email) }),
    { expirationTtl: VERIFY_TOKEN_TTL_SECONDS }
  );
  return token;
}

/**
 * Read a verification token from KV. Returns the email it activates, or
 * null if the token doesn't exist / is expired / is malformed.
 */
export async function consumeVerificationToken(
  kv: KVNamespace,
  token: string
): Promise<string | null> {
  if (!token || typeof token !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
    return null;
  }
  const raw = await kv.get(verifyKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { email?: string };
    if (typeof parsed.email !== "string") return null;
    /** Best-effort single-use: ignore failures so the user still gets through. */
    await kv.delete(verifyKey(token)).catch(() => undefined);
    return parsed.email;
  } catch {
    return null;
  }
}
