import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import path from "path";
import fs from "fs";

/**
 * Dev-time stand-in for the Pages Function at `/api/knowledge/[slug]`.
 *
 * Production routes:
 *   - GET     /api/knowledge/<slug>  → KV override or static asset
 *   - POST    /api/knowledge/<slug>  → write KV override (auth-gated)
 *   - DELETE  /api/knowledge/<slug>  → drop KV override (auth-gated)
 *
 * In dev there is no KV. Writes go straight to `public/knowledge/<slug>.txt`
 * on disk so the local chat plugin (which `fs.readFileSync`s those files) sees
 * the change immediately. Auth is skipped — dev is single-user on localhost.
 */
const SLUG_RE = /^[a-z0-9-]{1,40}$/;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

export function knowledgeDevApiPlugin(appRoot: string): Plugin {
  const knowledgeDir = path.join(appRoot, "public/knowledge");

  return {
    name: "knowledge-dev-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        const match = /^\/api\/knowledge\/([^/]+)$/.exec(pathname);
        if (!match) {
          next();
          return;
        }
        const slug = match[1];
        if (!SLUG_RE.test(slug)) {
          sendJson(res, 400, { error: "Invalid slug" });
          return;
        }

        const filePath = path.join(knowledgeDir, `${slug}.txt`);

        if (req.method === "GET") {
          try {
            const text = fs.readFileSync(filePath, "utf8");
            sendJson(res, 200, { slug, text, source: "asset" });
          } catch {
            sendJson(res, 404, { error: "Not found" });
          }
          return;
        }

        if (req.method === "POST") {
          let raw: string;
          try {
            raw = await readBody(req);
          } catch {
            sendJson(res, 400, { error: "Invalid body" });
            return;
          }
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON" });
            return;
          }
          const text = (body as { text?: unknown })?.text;
          if (typeof text !== "string") {
            sendJson(res, 400, { error: "Body must be { text: string }" });
            return;
          }
          if (text.length > 64 * 1024) {
            sendJson(res, 413, { error: "Knowledge text exceeds 64 KiB limit" });
            return;
          }
          try {
            fs.writeFileSync(filePath, text, "utf8");
            sendJson(res, 200, { ok: true, slug, length: text.length });
          } catch (e) {
            console.error("[knowledge dev] write failed:", e);
            sendJson(res, 500, { error: "Write failed" });
          }
          return;
        }

        if (req.method === "DELETE") {
          /**
           * In production this drops the KV override and returns the static
           * asset; in dev there is no override layer to drop, so we just
           * echo whatever's on disk back to the client.
           */
          try {
            const text = fs.readFileSync(filePath, "utf8");
            sendJson(res, 200, { ok: true, slug, text, source: "asset" });
          } catch {
            sendJson(res, 404, { error: "Not found" });
          }
          return;
        }

        sendJson(res, 405, { error: "Method not allowed" });
      });
    },
  };
}
