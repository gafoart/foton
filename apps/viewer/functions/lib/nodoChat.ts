/**
 * Nodo Public API backend for the chatbot panel.
 *
 * Replaces the direct OpenAI call: the message goes to the Nodo agent
 * (tenant Changan — centralized knowledge, traces, CRM, human handoff) and
 * this helper polls for the reply SERVER-SIDE so the frontend contract stays
 * `{ reply }` (no UI changes needed).
 *
 * Active only when NODO_API_KEY is configured (Pages secret) — without it,
 * /api/chat falls back to the legacy OpenAI flow.
 */

import { NodoClient, NodoApiError } from "../nodo-client/index.js";

const POLL_INTERVAL_MS = 2_000;
const POLL_DEADLINE_MS = 45_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface NodoChatResult {
  reply?: string;
  error?: string;
  status: number;
}

export async function nodoChat(args: {
  apiKey: string;
  baseUrl?: string;
  sessionId: string;
  text: string;
}): Promise<NodoChatResult> {
  const nodo = new NodoClient({ apiKey: args.apiKey, baseUrl: args.baseUrl });

  let conversationId: string;
  let sentMessageId: string;
  try {
    const sent = await nodo.sendMessage({ sessionId: args.sessionId, text: args.text });
    conversationId = sent.conversation_id;
    sentMessageId = sent.message_id;
  } catch (err) {
    if (err instanceof NodoApiError && err.status === 429) {
      return { error: "Demasiados mensajes seguidos. Espera unos segundos e intenta de nuevo.", status: 429 };
    }
    return { error: "No se pudo enviar el mensaje al asistente.", status: 502 };
  }

  // Poll for the first agent/operator reply AFTER our message.
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let since = sentMessageId;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const { messages } = await nodo.getMessages(conversationId, { since });
      const reply = messages.find((m) => m.direction === "outbound" && m.content);
      if (reply) {
        return { reply: reply.content as string, status: 200 };
      }
      if (messages.length > 0) since = messages[messages.length - 1].id;
    } catch {
      // transient poll error — keep trying until the deadline
    }
  }

  return {
    error: "El asistente está tardando más de lo normal. Intenta de nuevo en un momento.",
    status: 504,
  };
}
