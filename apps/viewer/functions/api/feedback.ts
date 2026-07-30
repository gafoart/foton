import { withCors, corsPreflightHeaders, type EnvWithCors } from "../lib/cors.js";

/**
 * Feedback capture endpoint. Receives multipart/form-data with:
 *   - descripcion: string (long text)
 *   - vehiculo, color, dispositivo: single-select strings (must match Notion options)
 *   - media_kind: "image" | "video"
 *   - media: File (Blob) — captured screenshot or video
 *
 * Pipeline: store the media in R2 under `feedback/<timestamp>-<rand>.<ext>` →
 * build the public R2 URL → create a Notion page in `NOTION_DATABASE_ID` with
 * the file linked as an external URL.
 *
 * Required secrets / vars (set via `wrangler pages secret put` or dashboard):
 *   - NOTION_TOKEN              — internal integration token
 *   - NOTION_DATABASE_ID        — defaults to the hardcoded DB id below
 *   - R2_PUBLIC_BASE_URL        — e.g. https://pub-57dba95d5e42405eb49421305a3d16c3.r2.dev (no trailing slash)
 *
 * Bindings (in wrangler.toml):
 *   - FEEDBACK_R2 → R2 bucket
 */

type Env = {
  FEEDBACK_R2: R2Bucket;
  NOTION_TOKEN?: string;
  NOTION_DATABASE_ID?: string;
  R2_PUBLIC_BASE_URL?: string;
} & EnvWithCors;

const DEFAULT_NOTION_DATABASE_ID = "8f19a705-40dc-46e6-aeab-57565826a10c";
const NOTION_API_VERSION = "2022-06-28";

const VEHICLE_OPTIONS = ["Alsvin", "CS35", "CS55", "CS95", "Hunter", "Hunter Plus"];
const COLOR_OPTIONS = ["Blanco", "Rojo", "Gris", "Plata", "Negro"];
const DEVICE_OPTIONS = ["Mac", "Windows", "Android", "iPhone"];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function pickExtension(file: File, kind: string): string {
  const name = file.name || "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    return name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") || (kind === "image" ? "png" : "webm");
  }
  if (file.type.includes("png")) return "png";
  if (file.type.includes("jpeg") || file.type.includes("jpg")) return "jpg";
  if (file.type.includes("mp4")) return "mp4";
  if (file.type.includes("webm")) return "webm";
  return kind === "image" ? "png" : "webm";
}

function randomKey(ext: string): string {
  const ts = Date.now();
  // 8 hex chars from crypto.getRandomValues
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `feedback/${ts}-${rand}.${ext}`;
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
  const fileName = `feedback-${fields.mediaKind}.${fields.mediaUrl.split(".").pop() ?? "bin"}`;
  const body = {
    parent: { database_id: databaseId },
    properties: {
      // Notion DBs always have a "title" property — assumed here to be Descripción.
      // If the DB's title is named differently, the API call returns 400 and the
      // server logs the response body for the operator to fix.
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

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  return new Response(null, { status: 204, headers: corsPreflightHeaders(request, env) });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!env.NOTION_TOKEN?.trim()) {
    return withCors(request, env, json({ error: "NOTION_TOKEN not configured" }, 503));
  }
  if (!env.FEEDBACK_R2) {
    return withCors(request, env, json({ error: "FEEDBACK_R2 binding not configured" }, 503));
  }
  if (!env.R2_PUBLIC_BASE_URL?.trim()) {
    return withCors(request, env, json({ error: "R2_PUBLIC_BASE_URL not configured" }, 503));
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return withCors(request, env, json({ error: "Body must be multipart/form-data" }, 400));
  }

  const descripcion = String(form.get("descripcion") ?? "").trim();
  const vehiculo = String(form.get("vehiculo") ?? "").trim();
  const color = String(form.get("color") ?? "").trim();
  const dispositivo = String(form.get("dispositivo") ?? "").trim();
  const mediaKind = String(form.get("media_kind") ?? "").trim();
  const media = form.get("media");

  if (!descripcion) {
    return withCors(request, env, json({ error: "descripcion is required" }, 400));
  }
  if (!VEHICLE_OPTIONS.includes(vehiculo)) {
    return withCors(request, env, json({ error: `vehiculo must be one of ${VEHICLE_OPTIONS.join(", ")}` }, 400));
  }
  if (!COLOR_OPTIONS.includes(color)) {
    return withCors(request, env, json({ error: `color must be one of ${COLOR_OPTIONS.join(", ")}` }, 400));
  }
  if (!DEVICE_OPTIONS.includes(dispositivo)) {
    return withCors(request, env, json({ error: `dispositivo must be one of ${DEVICE_OPTIONS.join(", ")}` }, 400));
  }
  if (!(media instanceof File) || media.size === 0) {
    return withCors(request, env, json({ error: "media file is required" }, 400));
  }
  if (mediaKind !== "image" && mediaKind !== "video") {
    return withCors(request, env, json({ error: "media_kind must be 'image' or 'video'" }, 400));
  }

  // Upload to R2.
  const ext = pickExtension(media, mediaKind);
  const key = randomKey(ext);
  try {
    await env.FEEDBACK_R2.put(key, media.stream(), {
      httpMetadata: { contentType: media.type || (mediaKind === "image" ? "image/png" : "video/webm") },
    });
  } catch (err) {
    return withCors(
      request,
      env,
      json({ error: "R2 upload failed", detail: err instanceof Error ? err.message : String(err) }, 500)
    );
  }

  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const mediaUrl = `${base}/${key}`;

  const databaseId = (env.NOTION_DATABASE_ID?.trim() || DEFAULT_NOTION_DATABASE_ID).replace(
    /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/i,
    "$1-$2-$3-$4-$5"
  );

  const notionResult = await createNotionPage(env.NOTION_TOKEN, databaseId, {
    descripcion,
    vehiculo,
    color,
    dispositivo,
    mediaUrl,
    mediaKind,
  });

  if (!notionResult.ok) {
    return withCors(
      request,
      env,
      json(
        { error: "Notion API call failed", status: notionResult.status, detail: notionResult.body, mediaUrl },
        502
      )
    );
  }

  return withCors(request, env, json({ ok: true, mediaUrl }));
};
