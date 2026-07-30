import type { Plugin } from "vite";
import type { IncomingMessage } from "http";
import path from "path";
import fs from "fs";
import { randomUUID } from "node:crypto";
import { loadEnv } from "vite";
import {
  parseChatRequestBody,
  buildSystemContent,
  openaiChatCompletion,
  MODEL_DISPLAY,
  DEFAULT_OPENAI_MODEL,
  type ModelKnowledge,
} from "./functions/lib/chatCore.ts";
import { nodoChat } from "./functions/lib/nodoChat.ts";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Handles POST /api/chat during `pnpm dev` (Vite does not run Cloudflare Functions).
 * Set OPENAI_API_KEY in apps/viewer/.env.local or repo-root .env.local (see README).
 */
export function chatDevApiPlugin(appRoot: string): Plugin {
  const knowledgeDir = path.join(appRoot, "public/knowledge");
  const repoRoot = path.resolve(appRoot, "../..");

  return {
    name: "chat-dev-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (pathname !== "/api/chat" || req.method !== "POST") {
          next();
          return;
        }

        const mode = server.config.mode;
        const envApp = loadEnv(mode, appRoot, "");
        const envRoot = loadEnv(mode, repoRoot, "");
        const apiKey = (
          envApp.OPENAI_API_KEY ||
          envRoot.OPENAI_API_KEY ||
          process.env.OPENAI_API_KEY ||
          ""
        ).trim();
        const openaiModel = (
          envApp.OPENAI_MODEL ||
          envRoot.OPENAI_MODEL ||
          process.env.OPENAI_MODEL ||
          ""
        ).trim() || DEFAULT_OPENAI_MODEL;

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");

        // ── Nodo backend (switch = presence of NODO_API_KEY) ─────────────
        // Mirrors functions/api/chat.ts so `pnpm dev:viewer` exercises the
        // same chat backend as production. Remove the key to fall back to
        // the legacy OpenAI flow below.
        const nodoKey = (
          envApp.NODO_API_KEY ||
          envRoot.NODO_API_KEY ||
          process.env.NODO_API_KEY ||
          ""
        ).trim();
        if (nodoKey) {
          const nodoBaseUrl = (
            envApp.NODO_API_BASE_URL ||
            envRoot.NODO_API_BASE_URL ||
            process.env.NODO_API_BASE_URL ||
            ""
          ).trim() || undefined;

          let nodoBody: unknown;
          try {
            nodoBody = JSON.parse(await readBody(req));
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }
          const b = nodoBody as {
            sessionId?: unknown;
            messages?: Array<{ role?: string; content?: string }>;
          };
          const lastUser = Array.isArray(b.messages)
            ? [...b.messages]
                .reverse()
                .find(
                  (m) =>
                    m?.role === "user" &&
                    typeof m.content === "string" &&
                    m.content.trim()
                )
            : undefined;
          if (!lastUser?.content) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid request" }));
            return;
          }
          const sessionId =
            typeof b.sessionId === "string" &&
            /^[A-Za-z0-9._-]{1,128}$/.test(b.sessionId)
              ? b.sessionId
              : randomUUID();
          const result = await nodoChat({
            apiKey: nodoKey,
            baseUrl: nodoBaseUrl,
            sessionId,
            text: lastUser.content.trim().slice(0, 4096),
          });
          if (result.reply) {
            res.statusCode = 200;
            res.end(JSON.stringify({ reply: result.reply }));
            return;
          }
          res.statusCode = result.status;
          res.end(JSON.stringify({ error: result.error ?? "Sin respuesta." }));
          return;
        }

        if (!apiKey) {
          res.statusCode = 503;
          res.end(
            JSON.stringify({
              error:
                "Chat needs OPENAI_API_KEY in apps/viewer/.env.local or repo-root .env.local for Vite dev, or export it in your shell. Alternatively use pnpm pages:dev with .dev.vars.",
            })
          );
          return;
        }

        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Invalid body" }));
          return;
        }

        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        const parsed = parseChatRequestBody(body);
        if (!parsed) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Invalid request" }));
          return;
        }

        const { modelId, messages } = parsed;
        const vehicleName = MODEL_DISPLAY[modelId] ?? modelId;

        // Load the brand KB + every model's KB so the assistant can answer
        // about any car in the lineup, not just the one currently on screen.
        let brandKb: string;
        let models: ModelKnowledge[];
        try {
          brandKb = fs.readFileSync(path.join(knowledgeDir, "foton.txt"), "utf8");
          models = [...new Set([...Object.keys(MODEL_DISPLAY), modelId])]
            .map((id) => {
              try {
                const kb = fs.readFileSync(path.join(knowledgeDir, `${id}.txt`), "utf8");
                return { id, name: MODEL_DISPLAY[id] ?? id, kb };
              } catch {
                return null;
              }
            })
            .filter((m): m is ModelKnowledge => m !== null);
          if (models.length === 0) throw new Error("no model knowledge available");
        } catch (e) {
          console.error("[chat dev] knowledge read failed:", e);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to load knowledge files" }));
          return;
        }

        const systemContent = buildSystemContent(brandKb, models, modelId, vehicleName);
        const result = await openaiChatCompletion(apiKey, openaiModel, systemContent, messages);

        if (!result.ok) {
          res.statusCode = result.status;
          res.end(JSON.stringify({ error: result.error }));
          return;
        }

        res.statusCode = 200;
        res.end(JSON.stringify({ reply: result.reply }));
      });
    },
  };
}
