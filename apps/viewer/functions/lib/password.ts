/**
 * Password hashing for manual signups. PBKDF2-SHA-256 via Web Crypto.
 *
 * Encoded form: `pbkdf2$<iterations>$<salt-b64url>$<hash-b64url>`.
 * Self-describing so we can bump iterations later without touching the
 * verification path — old hashes stay valid until users next log in
 * (rehash-on-login is left as a future enhancement).
 *
 * Cloudflare Workers enforces a hard cap of 100,000 PBKDF2 iterations
 * (`NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are
 * not supported`). We use the ceiling. OWASP 2021's PBKDF2-SHA-256
 * recommendation was 600k, but Worker runtime limits trump the lab
 * recommendation; the salt + signed-cookie design absorbs the strength
 * gap for the threat model here (no offline DB dump).
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

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

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    /**
     * TS 5.7+ types `Uint8Array` as `Uint8Array<ArrayBufferLike>` which
     * doesn't unify with `BufferSource`. The cast is safe — the underlying
     * buffer of a locally-allocated Uint8Array is always an ArrayBuffer.
     */
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 5_000_000) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlToBytes(parts[2]);
    expected = base64UrlToBytes(parts[3]);
  } catch {
    return false;
  }
  const candidate = await derive(password, salt, iterations);
  return constantTimeEqual(candidate, expected);
}
