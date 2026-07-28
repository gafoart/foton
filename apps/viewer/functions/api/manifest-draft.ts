import { verifyEditorAuth, type AuthEnv } from "../lib/auth.js";
import {
  withCors,
  withCorsAllowAnonymousRead,
  type EnvWithCors,
} from "../lib/cors.js";

type Env = {
  MANIFEST_KV: KVNamespace;
} & AuthEnv &
  EnvWithCors;

const KV_KEY = "manifest-draft";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isValidManifestBody(data: unknown): data is { models: unknown[] } {
  if (typeof data !== "object" || data === null) return false;
  const m = (data as { models?: unknown }).models;
  return Array.isArray(m);
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const stored = await env.MANIFEST_KV.get(KV_KEY);
  const res = stored
    ? new Response(stored, {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      })
    : new Response("null", {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
  return withCorsAllowAnonymousRead(request, env, res);
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const auth = await verifyEditorAuth(request, env);
  if (!auth.ok) {
    return withCors(request, env, json({ error: auth.message }, auth.status));
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withCors(request, env, json({ error: "Invalid JSON" }, 400));
  }
  if (!isValidManifestBody(body)) {
    return withCors(request, env, json({ error: "Invalid manifest" }, 400));
  }
  await env.MANIFEST_KV.put(KV_KEY, JSON.stringify(body));
  return withCors(request, env, json({ ok: true }));
};
