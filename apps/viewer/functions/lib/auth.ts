import * as jose from "jose";

export type AuthEnv = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EDITOR_EMAILS?: string;
  MANIFEST_SAVE_SECRET?: string;
};

const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getJwks(teamDomain: string): ReturnType<typeof jose.createRemoteJWKSet> {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`)
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

function parseAllowedEmails(env: AuthEnv): Set<string> {
  const raw = env.ALLOWED_EDITOR_EMAILS?.trim() ?? "";
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

export async function verifyEditorAuth(
  request: Request,
  env: AuthEnv
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const hasAccess =
    Boolean(env.ACCESS_TEAM_DOMAIN?.trim()) && Boolean(env.ACCESS_AUD?.trim());
  const hasSecret = Boolean(env.MANIFEST_SAVE_SECRET?.length);
  const allowEmails = parseAllowedEmails(env);

  if (!hasAccess && !hasSecret) {
    return {
      ok: false,
      status: 503,
      message: "Manifest API auth is not configured (set Access vars or MANIFEST_SAVE_SECRET)",
    };
  }

  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt && hasAccess) {
    try {
      const team = env.ACCESS_TEAM_DOMAIN!.trim();
      const aud = env.ACCESS_AUD!.trim();
      const jwks = getJwks(team);
      const { payload } = await jose.jwtVerify(jwt, jwks, {
        issuer: `https://${team}`,
        audience: aud,
      });
      const email =
        typeof payload.email === "string"
          ? payload.email.toLowerCase()
          : "";
      if (allowEmails.size === 0) {
        return {
          ok: false,
          status: 403,
          message: "ALLOWED_EDITOR_EMAILS is empty — add your email in Pages environment variables",
        };
      }
      if (!email || !allowEmails.has(email)) {
        return { ok: false, status: 403, message: "Email not allowed" };
      }
      return { ok: true };
    } catch {
      return { ok: false, status: 401, message: "Invalid Access session" };
    }
  }

  const auth = request.headers.get("Authorization");
  const expected = hasSecret ? `Bearer ${env.MANIFEST_SAVE_SECRET}` : "";
  if (hasSecret && auth === expected) {
    return { ok: true };
  }

  if (hasAccess) {
    return {
      ok: false,
      status: 401,
      message: "Sign in via Cloudflare Access or use a valid save token",
    };
  }

  return { ok: false, status: 401, message: "Unauthorized" };
}
