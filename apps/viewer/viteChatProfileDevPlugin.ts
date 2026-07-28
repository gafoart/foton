import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import path from "path";
import fs from "fs";

const SETTINGS_FILE = "chat-settings.json";
const AVATAR_FILE = "chat-avatar";

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

interface ParsedMultipart {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

function parseMultipartAvatar(req: IncomingMessage, body: Buffer): ParsedMultipart | null {
  const ct = req.headers["content-type"] ?? "";
  const boundaryMatch = /boundary=(.+?)(?:;|$)/.exec(ct);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1];
  const boundaryBuf = Buffer.from(`--${boundary}`);

  const parts: Buffer[] = [];
  let start = 0;
  while (true) {
    const idx = body.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    if (start > 0) parts.push(body.subarray(start, idx));
    start = idx + boundaryBuf.length;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerStr = part.subarray(0, headerEnd).toString("utf8");
    if (!headerStr.includes('name="avatar"')) continue;
    const typeMatch = /Content-Type:\s*(.+)/i.exec(headerStr);
    const fileMatch = /filename="(.+?)"/i.exec(headerStr);
    let fileData = part.subarray(headerEnd + 4);
    if (fileData[fileData.length - 2] === 0x0d && fileData[fileData.length - 1] === 0x0a) {
      fileData = fileData.subarray(0, fileData.length - 2);
    }
    return {
      buffer: fileData,
      contentType: typeMatch?.[1]?.trim() ?? "image/png",
      filename: fileMatch?.[1] ?? "avatar",
    };
  }
  return null;
}

export function chatProfileDevPlugin(appRoot: string): Plugin {
  const dataDir = path.join(appRoot, ".dev-data");

  function ensureDataDir(): void {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  }

  function settingsPath(): string {
    return path.join(dataDir, SETTINGS_FILE);
  }

  function avatarPathBase(): string {
    return path.join(dataDir, AVATAR_FILE);
  }

  function readSettings(): { nickname: string } {
    try {
      const raw = fs.readFileSync(settingsPath(), "utf8");
      const data = JSON.parse(raw) as { nickname?: string };
      return { nickname: data.nickname ?? "PANDi" };
    } catch {
      return { nickname: "PANDi" };
    }
  }

  function findAvatarFile(): { path: string; contentType: string } | null {
    const exts: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };
    const base = avatarPathBase();
    for (const [ext, ct] of Object.entries(exts)) {
      const fp = base + ext;
      if (fs.existsSync(fp)) return { path: fp, contentType: ct };
    }
    return null;
  }

  return {
    name: "chat-profile-dev",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";

        /* --- /api/chat-settings --- */
        if (pathname === "/api/chat-settings") {
          if (req.method === "GET") {
            const settings = readSettings();
            sendJson(res, 200, { nickname: settings.nickname, avatarUrl: "/api/chat-avatar" });
            return;
          }
          if (req.method === "POST") {
            const raw = await readBody(req);
            let body: unknown;
            try {
              body = JSON.parse(raw.toString("utf8"));
            } catch {
              sendJson(res, 400, { error: "Invalid JSON" });
              return;
            }
            const nickname =
              typeof (body as { nickname?: unknown }).nickname === "string"
                ? ((body as { nickname: string }).nickname.trim().slice(0, 50) || "PANDi")
                : "PANDi";
            ensureDataDir();
            fs.writeFileSync(settingsPath(), JSON.stringify({ nickname }), "utf8");
            sendJson(res, 200, { ok: true, nickname, avatarUrl: "/api/chat-avatar" });
            return;
          }
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        /* --- /api/chat-avatar --- */
        if (pathname === "/api/chat-avatar") {
          if (req.method === "GET") {
            const found = findAvatarFile();
            if (found) {
              const data = fs.readFileSync(found.path);
              res.statusCode = 200;
              res.setHeader("Content-Type", found.contentType);
              res.setHeader("Cache-Control", "no-store");
              res.end(data);
            } else {
              res.statusCode = 302;
              res.setHeader("Location", "/ui-images/profile.png");
              res.end();
            }
            return;
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            const parsed = parseMultipartAvatar(req, body);
            if (!parsed) {
              sendJson(res, 400, { error: "Missing avatar file" });
              return;
            }
            if (parsed.buffer.length > 512 * 1024) {
              sendJson(res, 413, { error: "La imagen excede 512 KB." });
              return;
            }
            const extMap: Record<string, string> = {
              "image/png": ".png",
              "image/jpeg": ".jpg",
              "image/webp": ".webp",
              "image/gif": ".gif",
            };
            const ext = extMap[parsed.contentType] ?? ".png";
            ensureDataDir();
            // Remove any previous avatar files
            for (const e of Object.values(extMap)) {
              const fp = avatarPathBase() + e;
              try { fs.unlinkSync(fp); } catch { /* ok */ }
            }
            fs.writeFileSync(avatarPathBase() + ext, parsed.buffer);
            sendJson(res, 200, { ok: true, size: parsed.buffer.length, contentType: parsed.contentType });
            return;
          }
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        next();
      });
    },
  };
}
