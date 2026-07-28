import { verifyEditorAuth, type AuthEnv } from "../lib/auth.js";
import {
  withCors,
  withCorsAllowAnonymousRead,
  type EnvWithCors,
} from "../lib/cors.js";

type Env = {
  MANIFEST_KV: KVNamespace;
  ASSETS: Fetcher;
} & AuthEnv &
  EnvWithCors;

const KV_KEY = "manifest";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isValidManifestBody(data: unknown): data is { models: unknown[] } {
  if (typeof data !== "object" || data === null) return false;
  const m = (data as { models?: unknown }).models;
  return Array.isArray(m) && m.length > 0;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const stored = await env.MANIFEST_KV.get(KV_KEY);
  let res: Response;
  if (stored) {
    res = new Response(stored, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } else {
    const url = new URL("/manifest.json", request.url);
    const assetRes = await env.ASSETS.fetch(url.toString());
    res = assetRes;
  }
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
  const models = body.models as unknown[];
  const hasDealership = typeof (body as { dealership?: unknown }).dealership === "object";
  return withCors(
    request,
    env,
    json({
      ok: true,
      path: "kv:manifest",
      modelCount: models.length,
      hasDealership,
    })
  );
};
