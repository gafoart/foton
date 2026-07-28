/**
 * Webhook signature verification — consumer side.
 *
 * Mirrors the Nodo signing semantics exactly (see worker-shared
 * `webhook-delivery`): `X-Nodo-Signature: t=<unix s>,v1=<hmac>[,v1=...]`,
 * hmac = HMAC-SHA256(secret, `${t}.${body}`) hex. Accepts if ANY v1 matches
 * (multiple entries appear during secret rotation) and the timestamp is
 * within tolerance (default ±300s, anti-replay).
 *
 * WebCrypto implementation (async) — zero deps, runs in Workers/Pages/Node 18+.
 */

const DEFAULT_TOLERANCE_SECONDS = 300

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyWebhookSignature(
  body: string,
  signatureHeader: string,
  secret: string,
  opts?: { toleranceSeconds?: number; nowSeconds?: number },
): Promise<boolean> {
  try {
    if (!signatureHeader) return false
    const parts = signatureHeader.split(',')
    const tPart = parts.find((p) => p.startsWith('t='))
    const v1s = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3)).filter(Boolean)
    if (!tPart || v1s.length === 0) return false

    const ts = Number(tPart.slice(2))
    if (!Number.isFinite(ts)) return false

    const now = opts?.nowSeconds ?? Math.floor(Date.now() / 1000)
    const tolerance = opts?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
    if (Math.abs(now - ts) > tolerance) return false

    const expected = await hmacHex(secret, `${ts}.${body}`)
    return v1s.some((mac) => timingSafeEqualHex(mac, expected))
  } catch {
    return false
  }
}
