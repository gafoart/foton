import { isSameOrigin, verifyEditorSession } from "../lib/session.js";
import type { OAuthEnv } from "../lib/oauth.js";
import { withCors, type EnvWithCors } from "../lib/cors.js";

type Env = {
  MANIFEST_KV: KVNamespace;
} & OAuthEnv &
  EnvWithCors;

const KV_KEY = "chat-avatar";
const MAX_SIZE = 512 * 1024; // 512 KB
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;
  const meta = await env.MANIFEST_KV.getWithMetadata<{ contentType?: string }>(KV_KEY, "arrayBuffer");
  if (!meta.value) {
    return new Response(null, { status: 302, headers: { Location: "/ui-images/profile.png" } });
  }
  const contentType = meta.metadata?.contentType ?? "image/png";
  return new Response(meta.value, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=60",
    },
  });
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

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return withCors(request, env, json({ error: "Expected multipart/form-data" }, 400));
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return withCors(request, env, json({ error: "Invalid form data" }, 400));
  }

  const file = formData.get("avatar");
  if (!file || !(file instanceof File)) {
    return withCors(request, env, json({ error: "Missing 'avatar' file field" }, 400));
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return withCors(request, env, json({ error: "Tipo no permitido. Usa PNG, JPEG, WebP o GIF." }, 400));
  }

  if (file.size > MAX_SIZE) {
    return withCors(request, env, json({ error: "La imagen excede 512 KB." }, 413));
  }

  const bytes = await file.arrayBuffer();
  await env.MANIFEST_KV.put(KV_KEY, bytes, {
    metadata: { contentType: file.type },
  });

  return withCors(request, env, json({ ok: true, size: file.size, contentType: file.type }));
};
