import { withCors, type EnvWithCors } from "../lib/cors.js";
import {
  parseChatRequestBody,
  buildSystemContent,
  openaiChatCompletion,
  MODEL_DISPLAY,
  DEFAULT_OPENAI_MODEL,
  type ModelKnowledge,
} from "../lib/chatCore.js";
import { getKnowledgeText } from "../lib/knowledge.js";
import { nodoChat } from "../lib/nodoChat.js";

type Env = {
  ASSETS: Fetcher;
  MANIFEST_KV: KVNamespace;
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  /** Nodo Public API — when set, the chat is served by the Nodo agent (tenant Foton). */
  NODO_API_KEY?: string;
  NODO_API_BASE_URL?: string;
} & EnvWithCors;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // ── Nodo backend (switch = presence of the NODO_API_KEY secret) ──────────
  // The reply comes from the Nodo agent (centralized knowledge, traces, CRM,
  // human handoff). Poll happens server-side so the response contract stays
  // synchronous `{ reply }`. Remove the secret to fall back to OpenAI.
  if (env.NODO_API_KEY?.trim()) {
    let nodoBody: unknown;
    try {
      nodoBody = await request.clone().json();
    } catch {
      return withCors(request, env, json({ error: "Invalid JSON" }, 400));
    }
    const b = nodoBody as { sessionId?: unknown; messages?: Array<{ role?: string; content?: string }> };
    const lastUser = Array.isArray(b.messages)
      ? [...b.messages].reverse().find((m) => m?.role === "user" && typeof m.content === "string" && m.content.trim())
      : undefined;
    if (!lastUser?.content) {
      return withCors(request, env, json({ error: "Invalid request" }, 400));
    }
    // Stable per-visitor session (localStorage in the panel) → same Nodo
    // conversation across turns. Fallback: per-request id (no continuity).
    const sessionId =
      typeof b.sessionId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(b.sessionId)
        ? b.sessionId
        : crypto.randomUUID();
    const result = await nodoChat({
      apiKey: env.NODO_API_KEY,
      baseUrl: env.NODO_API_BASE_URL,
      sessionId,
      text: lastUser.content.trim().slice(0, 4096),
    });
    if (result.reply) {
      return withCors(request, env, json({ reply: result.reply }, 200));
    }
    return withCors(request, env, json({ error: result.error ?? "Sin respuesta." }, result.status));
  }

  if (!env.OPENAI_API_KEY?.trim()) {
    return withCors(request, env, json({ error: "Chat is not configured (missing API key)." }, 503));
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withCors(request, env, json({ error: "Invalid JSON" }, 400));
  }

  const parsed = parseChatRequestBody(body);
  if (!parsed) {
    return withCors(request, env, json({ error: "Invalid request" }, 400));
  }

  const { modelId, messages } = parsed;
  const vehicleName = MODEL_DISPLAY[modelId] ?? modelId;

  // Load the brand KB + every model's KB so the assistant can answer about any
  // car in the lineup (and compare), not just the one currently on screen.
  // The lineup list is the known-display set plus the requested model id
  // (validated as a slug upstream); ids without a knowledge file are dropped.
  const modelIds = [...new Set([...Object.keys(MODEL_DISPLAY), modelId])];
  let brandKb: string;
  let models: ModelKnowledge[];
  try {
    const [brandRec, ...modelRecs] = await Promise.all([
      getKnowledgeText(env.MANIFEST_KV, env.ASSETS, request.url, "foton"),
      ...modelIds.map((id) =>
        getKnowledgeText(env.MANIFEST_KV, env.ASSETS, request.url, id)
      ),
    ]);
    if (!brandRec) throw new Error("missing foton knowledge");
    models = modelIds
      .map((id, i) =>
        modelRecs[i]
          ? { id, name: MODEL_DISPLAY[id] ?? id, kb: modelRecs[i]!.text }
          : null
      )
      .filter((m): m is ModelKnowledge => m !== null);
    if (models.length === 0) throw new Error("no model knowledge available");
    brandKb = brandRec.text;
  } catch (e) {
    console.error("[chat] knowledge load failed:", e);
    return withCors(request, env, json({ error: "Failed to load knowledge files" }, 500));
  }

  const systemContent = buildSystemContent(brandKb, models, modelId, vehicleName);
  const openaiModel = env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;

  const result = await openaiChatCompletion(env.OPENAI_API_KEY, openaiModel, systemContent, messages);

  if (!result.ok) {
    return withCors(request, env, json({ error: result.error }, result.status));
  }

  return withCors(request, env, json({ reply: result.reply }));
};
