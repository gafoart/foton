/**
 * Model ids are manifest-driven, so instead of a hardcoded whitelist we accept
 * any well-formed slug (letters/digits/hyphen/underscore, max 64 chars). The
 * knowledge loader simply finds no KB file for ids it doesn't know.
 */
const MODEL_ID_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isValidModelIdSlug(id: string): boolean {
  return MODEL_ID_SLUG_RE.test(id);
}

/** Known display names; unknown ids fall back to the id itself at call sites. */
export const MODEL_DISPLAY: Record<string, string> = {
  "3t": "Foton 3T",
};

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
// Sliding context window: conversations longer than this don't error — the
// oldest turns are dropped so the chat can continue indefinitely while keeping
// the request payload (and OpenAI token cost) bounded.
export const MAX_MESSAGES = 100;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_COMPLETION_TOKENS = 1024;

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

function isChatRole(r: unknown): r is ChatRole {
  return r === "user" || r === "assistant";
}

export function parseChatRequestBody(
  data: unknown
): { modelId: string; messages: ChatMessage[] } | null {
  if (typeof data !== "object" || data === null) return null;
  const o = data as { modelId?: unknown; messages?: unknown };
  if (typeof o.modelId !== "string" || !isValidModelIdSlug(o.modelId)) return null;
  if (!Array.isArray(o.messages)) return null;
  const messages: ChatMessage[] = [];
  for (const item of o.messages) {
    if (typeof item !== "object" || item === null) return null;
    const m = item as { role?: unknown; content?: unknown };
    if (!isChatRole(m.role) || typeof m.content !== "string") return null;
    if (m.content.length > MAX_MESSAGE_CHARS) return null;
    messages.push({ role: m.role, content: m.content });
  }
  if (messages.length === 0) return null;
  // Don't reject long chats — keep only the most recent MAX_MESSAGES so older
  // turns slide out of the context window instead of erroring the request.
  const trimmed =
    messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages;
  return { modelId: o.modelId, messages: trimmed };
}

export interface ModelKnowledge {
  id: string;
  name: string;
  kb: string;
}

export function buildSystemContent(
  brandKb: string,
  models: ModelKnowledge[],
  currentModelId: string,
  currentVehicleName: string
): string {
  const lineup = models
    .map((m) => `--- ${m.name} (model id: ${m.id}) ---\n${m.kb.trim()}`)
    .join("\n\n");
  return [
    "You are Chatbot, the showroom assistant for Foton vehicles.",
    `The user is currently viewing: ${currentVehicleName} (model id: ${currentModelId}).`,
    "You can answer questions about ANY Foton model in the lineup below, including comparing them. When the user is vague, assume they mean the current model.",
    "Prefer the knowledge below for Foton-specific facts. For general automotive questions not covered here, you may use your general knowledge — but never invent Foton specs you don't have; say you don't have that detail instead.",
    "",
    "--- Foton (brand & behavior) ---",
    brandKb.trim(),
    "",
    "=== Foton lineup ===",
    lineup,
  ].join("\n");
}

export type OpenAiChatResult =
  | { ok: true; reply: string }
  | { ok: false; error: string; status: number };

export async function openaiChatCompletion(
  apiKey: string,
  openaiModel: string,
  systemContent: string,
  messages: ChatMessage[]
): Promise<OpenAiChatResult> {
  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openaiModel,
      messages: [{ role: "system", content: systemContent }, ...messages],
      max_tokens: MAX_COMPLETION_TOKENS,
    }),
  });

  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    console.error("[chat] OpenAI error:", openaiRes.status, errText.slice(0, 500));
    return {
      ok: false,
      error: "The assistant could not complete the request. Try again later.",
      status: 502,
    };
  }

  let completion: {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  try {
    completion = (await openaiRes.json()) as typeof completion;
  } catch {
    return { ok: false, error: "Invalid response from assistant", status: 502 };
  }

  const reply = completion.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    return { ok: false, error: "Empty assistant reply", status: 502 };
  }

  return { ok: true, reply };
}
