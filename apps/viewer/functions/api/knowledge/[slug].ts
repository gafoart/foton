import { isSameOrigin, verifyEditorSession } from "../../lib/session.js";
import { type OAuthEnv } from "../../lib/oauth.js";
import {
  withCors,
  withCorsAllowAnonymousRead,
  type EnvWithCors,
} from "../../lib/cors.js";
import {
  fetchKnowledgeAsset,
  getKnowledgeText,
  isValidKnowledgeSlug,
  knowledgeKvKey,
} from "../../lib/knowledge.js";

type Env = {
  MANIFEST_KV: KVNamespace;
  ASSETS: Fetcher;
} & OAuthEnv &
  EnvWithCors;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function getSlug(params: Record<string, string | string[] | undefined>): string | null {
  const raw = params.slug;
  const slug = Array.isArray(raw) ? raw[0] : raw;
  if (typeof slug !== "string") return null;
  return isValidKnowledgeSlug(slug) ? slug : null;
}

/**
 * Returns the current content of a knowledge file. KV override wins; falls
 * back to the static asset shipped with the build. Anonymous reads are
 * allowed so the editor UI can hydrate without authentication — only writes
 * are gated.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;
  const slug = getSlug(params);
  if (!slug) {
    return withCors(request, env, json({ error: "Invalid slug" }, 400));
  }

  const record = await getKnowledgeText(env.MANIFEST_KV, env.ASSETS, request.url, slug);
  if (!record) {
    return withCors(request, env, json({ error: "Not found" }, 404));
  }

  return withCorsAllowAnonymousRead(
    request,
    env,
    json({ slug, text: record.text, source: record.source })
  );
};

/**
 * Replaces the knowledge file content in KV. Auth-gated by the same signed
 * session cookie that protects the `/ia` editor page — signing in once via
 * `/auth/login` (Google OAuth or email/password) authorizes both viewing
 * and editing.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;
  const slug = getSlug(params);
  if (!slug) {
    return withCors(request, env, json({ error: "Invalid slug" }, 400));
  }

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

  const text = (body as { text?: unknown })?.text;
  if (typeof text !== "string") {
    return withCors(request, env, json({ error: "Body must be { text: string }" }, 400));
  }

  /**
   * Cap at 64 KiB. The chatbot uses these as system prompt — anything larger
   * is almost certainly a paste accident, and Workers KV values bill on size.
   */
  if (text.length > 64 * 1024) {
    return withCors(
      request,
      env,
      json({ error: "Knowledge text exceeds 64 KiB limit" }, 413)
    );
  }

  await env.MANIFEST_KV.put(knowledgeKvKey(slug), text);
  return withCors(request, env, json({ ok: true, slug, length: text.length }));
};

/**
 * Removes the KV override so the static asset becomes authoritative again.
 * Useful as a "Restablecer original" button on the editor.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;
  const slug = getSlug(params);
  if (!slug) {
    return withCors(request, env, json({ error: "Invalid slug" }, 400));
  }

  if (!isSameOrigin(request)) {
    return withCors(request, env, json({ error: "Cross-origin write blocked" }, 403));
  }

  const auth = await verifyEditorSession(request, env);
  if (!auth.ok) {
    return withCors(request, env, json({ error: auth.message }, auth.status));
  }
  await env.MANIFEST_KV.delete(knowledgeKvKey(slug));

  /** Return the fresh asset content so the editor can sync without a re-fetch. */
  const fallback = await fetchKnowledgeAsset(env.ASSETS, request.url, slug);
  return withCors(
    request,
    env,
    json({ ok: true, slug, text: fallback ?? "", source: "asset" })
  );
};
