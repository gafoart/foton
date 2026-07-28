import { isSameOrigin, verifyEditorSession } from "../lib/session.js";
import type { OAuthEnv } from "../lib/oauth.js";
import { withCors, withCorsAllowAnonymousRead, type EnvWithCors } from "../lib/cors.js";

type Env = {
  MANIFEST_KV: KVNamespace;
} & OAuthEnv &
  EnvWithCors;

const KV_KEY = "chat-settings";

export interface ChatSettings {
  nickname: string;
  avatarUrl: string;
}

const DEFAULTS: ChatSettings = {
  nickname: "PANDi",
  avatarUrl: "/api/chat-avatar",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const raw = await env.MANIFEST_KV.get(KV_KEY, "text");
  let settings: ChatSettings = { ...DEFAULTS };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ChatSettings>;
      if (typeof parsed.nickname === "string" && parsed.nickname.trim()) {
        settings.nickname = parsed.nickname.trim();
      }
    } catch {
      // ignore malformed
    }
  }
  // Avatar is always served from the dedicated endpoint
  settings.avatarUrl = "/api/chat-avatar";
  return withCorsAllowAnonymousRead(request, env, json(settings));
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!isSameOrigin(request)) {
    return withCors(request, env, json({ error: "Cross-origin write blocked" }, 403));
  }

  const auth = await verifyEditorSession(request, env);
  if (!auth.ok) {
    return withCors(request, env, json({ error: auth.message }, auth.status));
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withCors(request, env, json({ error: "Invalid JSON" }, 400));
  }

  const o = body as { nickname?: unknown };
  const nickname =
    typeof o.nickname === "string" && o.nickname.trim()
      ? o.nickname.trim().slice(0, 50)
      : DEFAULTS.nickname;

  const settings: ChatSettings = { nickname, avatarUrl: DEFAULTS.avatarUrl };
  await env.MANIFEST_KV.put(KV_KEY, JSON.stringify({ nickname }));
  return withCors(request, env, json({ ok: true, ...settings }));
};
