/**
 * Best-effort per-IP rate limiter backed by Workers KV.
 *
 * KV is eventually consistent, so a determined attacker who fires many
 * parallel requests can briefly exceed the limit (each parallel request
 * may see the same stale count). For a small-team login form this is
 * enough to thwart sequential credential-stuffing scripts without needing
 * Durable Objects. If/when the attack surface grows, swap this for a
 * Durable Object counter (one DO per IP) or a Cloudflare Rate Limiting
 * Rule configured in the dashboard.
 *
 * Failure mode: if KV is unavailable we return `allowed: true` (fail
 * open). The trade-off is availability over strict enforcement — the
 * downstream auth still has to pass and a KV outage shouldn't lock every
 * legitimate user out.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** How many requests remain in the current window after this call. */
  remaining: number;
  /** Window length in seconds (constant per call; useful for Retry-After). */
  resetSeconds: number;
}

export async function rateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  let count = 0;
  try {
    const raw = await kv.get(key);
    count = raw ? Number.parseInt(raw, 10) || 0 : 0;
  } catch {
    return { allowed: true, remaining: limit, resetSeconds: windowSeconds };
  }
  if (count >= limit) {
    return { allowed: false, remaining: 0, resetSeconds: windowSeconds };
  }
  try {
    await kv.put(key, String(count + 1), { expirationTtl: windowSeconds });
  } catch {
    /** Increment failed — let the request through; next attempt will retry. */
  }
  return { allowed: true, remaining: limit - count - 1, resetSeconds: windowSeconds };
}

/**
 * Build a per-IP KV key. `scope` lets the same IP have independent buckets
 * for different endpoints (e.g. login vs register) without one starving
 * the other.
 */
export function ipKey(request: Request, scope: string): string {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return `ratelimit:${scope}:${ip}`;
}
