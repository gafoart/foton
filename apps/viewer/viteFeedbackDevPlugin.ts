import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "node:stream";
import path from "path";
import fs from "fs";
import { loadEnv } from "vite";

const NOTION_API_VERSION = "2022-06-28";
const DEFAULT_NOTION_DATABASE_ID = "8f19a705-40dc-46e6-aeab-57565826a10c";

const VEHICLE_OPTIONS = ["Alsvin", "CS35", "CS55", "CS95", "Hunter", "Hunter Plus"];
const COLOR_OPTIONS = ["Blanco", "Rojo", "Gris", "Plata", "Negro"];
const DEVICE_OPTIONS = ["Mac", "Windows", "Android", "iPhone"];

/**
 * Handles POST /api/feedback during `pnpm dev:viewer` (Vite alone — Cloudflare
 * Pages Functions don't run). Reads `.dev.vars`, `.env.local` and shell env
 * for `NOTION_TOKEN` etc., saves the captured media to
 * `apps/viewer/public/feedback/<key>` so Vite serves it at
 * `http://localhost:5175/feedback/<key>`, and creates the Notion page.
 *
 * The file URL passed to Notion is the localhost one — that means the row
 * appears in the DB immediately, but the file thumbnail won't load when
 * viewed from another network. For real R2-backed E2E, run
 * `pnpm --filter viewer run pages:dev` (the Pages Function path).
 */

function readDevEnv(appRoot: string, mode: string): {
  NOTION_TOKEN: string;
  NOTION_DATABASE_ID: string;
  R2_PUBLIC_BASE_URL: string;
} {
  const envApp = loadEnv(mode, appRoot, "");
  const repoRoot = path.resolve(appRoot, "../..");
  const envRoot = loadEnv(mode, repoRoot, "");

  // Wrangler's `.dev.vars` is plain KEY=VALUE. Vite's loadEnv ignores it.
  const devVarsPath = path.join(appRoot, ".dev.vars");
  const devVars: Record<string, string> = {};
  if (fs.existsSync(devVarsPath)) {
    const raw = fs.readFileSync(devVarsPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      devVars[k] = v;
    }
  }

  const pick = (key: string): string =>
    (devVars[key] || envApp[key] || envRoot[key] || process.env[key] || "").trim();

  return {
    NOTION_TOKEN: pick("NOTION_TOKEN"),
    NOTION_DATABASE_ID: pick("NOTION_DATABASE_ID") || DEFAULT_NOTION_DATABASE_ID,
    R2_PUBLIC_BASE_URL: pick("R2_PUBLIC_BASE_URL"),
  };
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function pickExtension(file: File, kind: string): string {
  const name = file.name || "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    return name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") || (kind === "image" ? "png" : "webm");
  }
  if (file.type.includes("png")) return "png";
  if (file.type.includes("jpeg")) return "jpg";
  if (file.type.includes("mp4")) return "mp4";
  if (file.type.includes("webm")) return "webm";
  return kind === "image" ? "png" : "webm";
}

function randomKey(ext: string): string {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `${ts}-${rand}.${ext}`;
}

async function createNotionPage(
  token: string,
  databaseId: string,
  fields: {
    descripcion: string;
    vehiculo: string;
    color: string;
    dispositivo: string;
    mediaUrl: string;
    mediaKind: string;
  }
): Promise<{ ok: true } | { ok: false; status: number; body: string }> {
  const ext = fields.mediaUrl.split(".").pop() ?? "bin";
  const fileName = `feedback-${fields.mediaKind}.${ext}`;
  const body = {
    parent: { database_id: databaseId },
    properties: {
      "Descripción": {
        title: [{ type: "text", text: { content: fields.descripcion.slice(0, 2000) } }],
      },
      "Vehículo": { select: { name: fields.vehiculo } },
      "Color": { select: { name: fields.color } },
      "Dispositivo": { select: { name: fields.dispositivo } },
      "Imágenes": {
        files: [
          {
            name: fileName.slice(0, 100),
            type: "external",
            external: { url: fields.mediaUrl },
          },
        ],
      },
    },
  };

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return { ok: false, status: res.status, body: await res.text() };
  }
  return { ok: true };
}

export function feedbackDevApiPlugin(appRoot: string): Plugin {
  const feedbackPublicDir = path.join(appRoot, "public", "feedback");
  if (!fs.existsSync(feedbackPublicDir)) {
    fs.mkdirSync(feedbackPublicDir, { recursive: true });
  }

  return {
    name: "feedback-dev-api",
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (pathname !== "/api/feedback" || req.method !== "POST") {
          next();
          return;
        }

        const env = readDevEnv(appRoot, server.config.mode);
        if (!env.NOTION_TOKEN) {
          jsonResponse(res, 503, {
            error:
              "NOTION_TOKEN missing. Add it to apps/viewer/.dev.vars or .env.local.",
          });
          return;
        }

        // Convert Node IncomingMessage to Web Request so we can use formData().
        let formData: FormData;
        try {
          const webStream = Readable.toWeb(req as unknown as Readable);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === "string") headers.set(k, v);
            else if (Array.isArray(v)) headers.set(k, v.join(","));
          }
          const webReq = new Request("http://localhost/api/feedback", {
            method: "POST",
            headers,
            // @ts-expect-error duplex required by Node fetch when body is stream
            body: webStream,
            duplex: "half",
          });
          formData = await webReq.formData();
        } catch (err) {
          jsonResponse(res, 400, {
            error: "Failed to parse multipart body",
            detail: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        const descripcion = String(formData.get("descripcion") ?? "").trim();
        const vehiculo = String(formData.get("vehiculo") ?? "").trim();
        const color = String(formData.get("color") ?? "").trim();
        const dispositivo = String(formData.get("dispositivo") ?? "").trim();
        const mediaKind = String(formData.get("media_kind") ?? "").trim();
        const media = formData.get("media");

        if (!descripcion) return jsonResponse(res, 400, { error: "descripcion required" });
        if (!VEHICLE_OPTIONS.includes(vehiculo))
          return jsonResponse(res, 400, { error: `vehiculo invalid` });
        if (!COLOR_OPTIONS.includes(color)) return jsonResponse(res, 400, { error: `color invalid` });
        if (!DEVICE_OPTIONS.includes(dispositivo))
          return jsonResponse(res, 400, { error: `dispositivo invalid` });
        if (!(media instanceof File) || media.size === 0)
          return jsonResponse(res, 400, { error: "media file required" });
        if (mediaKind !== "image" && mediaKind !== "video")
          return jsonResponse(res, 400, { error: "media_kind must be image|video" });

        // Persist locally so Vite serves it at /feedback/<key>.
        const ext = pickExtension(media, mediaKind);
        const key = randomKey(ext);
        const filePath = path.join(feedbackPublicDir, key);
        try {
          const buf = Buffer.from(await media.arrayBuffer());
          fs.writeFileSync(filePath, buf);
        } catch (err) {
          jsonResponse(res, 500, {
            error: "Local file write failed",
            detail: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        // Vite dev server origin from request headers.
        const host = req.headers.host ?? "localhost:5175";
        const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
        const localUrl = `${proto}://${host}/feedback/${key}`;

        const notionResult = await createNotionPage(env.NOTION_TOKEN, env.NOTION_DATABASE_ID, {
          descripcion,
          vehiculo,
          color,
          dispositivo,
          mediaUrl: localUrl,
          mediaKind,
        });

        if (!notionResult.ok) {
          jsonResponse(res, 502, {
            error: "Notion API call failed",
            status: notionResult.status,
            detail: notionResult.body,
            mediaUrl: localUrl,
          });
          return;
        }

        // eslint-disable-next-line no-console
        console.log(`[feedback dev] Saved ${key} -> Notion page created (localhost URL: ${localUrl})`);
        jsonResponse(res, 200, { ok: true, mediaUrl: localUrl, devNote: "Localhost URL — only visible from your machine." });
      });
    },
  };
}
