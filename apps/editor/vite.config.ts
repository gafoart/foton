import { defineConfig, type Plugin } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

/** Kept in sync with @changan/shared `manifest/colors.ts` (Vite config cannot import the package barrel in Node). */
function sortColorsForShowroom<T extends { id: string }>(colors: T[]): T[] {
  return [...colors].sort((a, b) => {
    const aw = a.id.toLowerCase() === "white" ? 0 : 1;
    const bw = b.id.toLowerCase() === "white" ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return a.id.localeCompare(b.id);
  });
}

function resolveDefaultColorId(colors: { id: string }[]): string {
  const w = colors.find((c) => c.id.toLowerCase() === "white");
  if (w) return w.id;
  return colors[0]?.id ?? "";
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";

const execFileAsync = promisify(execFile);

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const WASM_DATA_URI_RE = /new URL\(\s*"data:application\/wasm[^"]+"\s*,\s*import\.meta\.url\s*\)/g;
const WASM_REPLACEMENT = 'new URL("/spark_bg.wasm", import.meta.url)';

const sparkWasmEsbuildPlugin = {
  name: "spark-wasm-data-url-fix",
  setup(build: { onLoad: Function }) {
    build.onLoad({ filter: /spark\.module\.js$/ }, (args: { path: string }) => {
      const source = fs.readFileSync(args.path, "utf-8");
      return { contents: source.replace(WASM_DATA_URI_RE, WASM_REPLACEMENT), loader: "js" };
    });
  },
};

function sparkWasmVitePlugin(): Plugin {
  return {
    name: "spark-wasm-data-url-fix-transform",
    enforce: "pre",
    transform(code, id) {
      if (id.includes("spark") && WASM_DATA_URI_RE.test(code)) {
        WASM_DATA_URI_RE.lastIndex = 0;
        return { code: code.replace(WASM_DATA_URI_RE, WASM_REPLACEMENT), map: null };
      }
    },
  };
}

const repoSplatsDir = path.resolve(__dirname, "../../assets/splats");
const viewerManifestPath = path.resolve(__dirname, "../viewer/public/manifest.json");

/** Auto-discover models from splats folder. Convention: splats/<modelId>/{modelId}_{color}_ext.sog|.sag, {modelId}_{color}_motor.sog|.sag, {modelId}_int.sog|.sag */
function discoverManifestFromSplats(splatsDir: string): object | null {
  if (!fs.existsSync(splatsDir) || !fs.statSync(splatsDir).isDirectory()) return null;
  const entries = fs.readdirSync(splatsDir, { withFileTypes: true });
  const modelDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  if (modelDirs.length === 0) return null;

  const defaultTransform = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: 1 };
  const defaultBookmarks = {
    exterior: { pos: [0, 0.5, 1.5], target: [0, 0, -0.8] },
    detail: { pos: [0, 0.3, -1.5], target: [0, 0, -0.8] },
    interior: { pos: [0, 0.25, -0.5], target: [0, 0, -0.8] },
  };
  const makeAsset = (url: string) => ({ url, fileType: "zip", transform: defaultTransform });
  const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isSplatAsset = (f: string) => f.endsWith(".sog") || f.endsWith(".sag") || f.endsWith(".ozg");

  const models: object[] = [];
  for (const modelId of modelDirs) {
    const modelPath = path.join(splatsDir, modelId);
    const files = fs.readdirSync(modelPath).filter(isSplatAsset);
    let interiorFile: string | null = null;
    const exteriorByColor = new Map<string, string>();
    const detailByColor = new Map<string, string>();

    for (const file of files) {
      const base = file.replace(/\.(sog|sag|ozg)$/i, "");
      if (base === `${modelId}_int`) interiorFile = file;
      else {
        const extM = base.match(new RegExp(`^${esc(modelId)}_(.+)_ext$`));
        const motorM = base.match(new RegExp(`^${esc(modelId)}_(.+)_motor$`));
        if (extM) exteriorByColor.set(extM[1].toLowerCase(), file);
        if (motorM) detailByColor.set(motorM[1].toLowerCase(), file);
      }
    }
    // Interior optional: allow models with only exterior+detail
    const interiorAsset = interiorFile ? makeAsset(`/splats/${modelId}/${interiorFile}`) : null;

    const colors: object[] = [];
    const colorIds = new Set([...exteriorByColor.keys(), ...detailByColor.keys()]);
    const fallbackMotor = detailByColor.values().next().value;
    for (const colorId of colorIds) {
      const extFile = exteriorByColor.get(colorId);
      const motorFile = detailByColor.get(colorId) ?? fallbackMotor ?? extFile; // use exterior as fallback for detail
      if (!extFile) continue;
      colors.push({
        id: colorId,
        name: humanize(colorId),
        assets: {
          exterior: makeAsset(`/splats/${modelId}/${extFile}`),
          detail: makeAsset(`/splats/${modelId}/${motorFile}`),
        },
      });
    }
    if (colors.length === 0) continue;

    const colorsSorted = sortColorsForShowroom(colors as { id: string }[]);

    models.push({
      id: modelId,
      name: humanize(modelId),
      colors: colorsSorted,
      interior: interiorAsset ?? makeAsset(`/splats/${modelId}/${exteriorByColor.values().next().value}`), // placeholder if no interior
      bookmarks: defaultBookmarks,
      cameraBookmarks: [],
      annotations: [],
    });
  }
  if (models.length === 0) return null;
  const first = models[0] as { id: string; colors: { id: string }[] };
  return {
    version: 1,
    defaults: {
      modelId: first.id,
      colorId: resolveDefaultColorId(first.colors),
      view: "exterior",
    },
    models,
  };
}

/** In-memory manifest store so the showroom (different port) can fetch it */
let manifestDraftStore: string | null = null;

/**
 * Dev-only POST endpoints for the editor UI: deploy viewer+editor to Cloudflare Pages, push git.
 * Optional: set EDITOR_DEPLOY_SECRET in the environment and VITE_EDITOR_DEPLOY_SECRET for the client header.
 */
function editorDevDeployHooksPlugin(): Plugin {
  const repoRoot = path.resolve(__dirname, "../..");
  const gitPushScript = path.join(repoRoot, "scripts/editor-git-push.sh");

  const sendJson = (res: ServerResponse, status: number, body: Record<string, unknown>) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const cors = (res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Editor-Deploy-Secret");
  };

  const checkAuth = (req: IncomingMessage): boolean => {
    const secret = process.env.EDITOR_DEPLOY_SECRET?.trim();
    if (!secret) return true;
    return req.headers["x-editor-deploy-secret"] === secret;
  };

  return {
    name: "editor-dev-deploy-hooks",
    configureServer(server) {
      const handle =
        (kind: "cloudflare" | "github") =>
        async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          const base = kind === "cloudflare" ? "/__deploy/cloudflare" : "/__deploy/github";
          if (!req.url?.startsWith(base)) return next();
          if (req.method === "OPTIONS") {
            cors(res);
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.method !== "POST") return next();
          cors(res);
          if (!checkAuth(req)) {
            sendJson(res, 403, { ok: false, error: "Invalid or missing deploy secret" });
            return;
          }
          try {
            if (kind === "cloudflare") {
              const { stdout, stderr } = await execFileAsync(
                "bash",
                ["-lc", "pnpm run pages:deploy:viewer && pnpm run pages:deploy:editor"],
                {
                  cwd: repoRoot,
                  maxBuffer: 50 * 1024 * 1024,
                  env: process.env,
                }
              );
              sendJson(res, 200, {
                ok: true,
                stdout: stdout.toString(),
                stderr: stderr.toString(),
              });
            } else {
              const { stdout, stderr } = await execFileAsync("bash", [gitPushScript], {
                cwd: repoRoot,
                maxBuffer: 20 * 1024 * 1024,
                env: process.env,
              });
              const out = stdout.toString();
              const noChanges = out.includes("EDITOR_GIT_NO_CHANGES");
              sendJson(res, 200, {
                ok: true,
                noChanges,
                stdout: out,
                stderr: stderr.toString(),
              });
            }
          } catch (e: unknown) {
            const err = e as { message?: string; stdout?: Buffer; stderr?: Buffer; code?: string | number };
            sendJson(res, 500, {
              ok: false,
              error: err.message ?? String(e),
              stdout: err.stdout?.toString() ?? "",
              stderr: err.stderr?.toString() ?? "",
            });
          }
        };

      server.middlewares.use(handle("cloudflare"));
      server.middlewares.use(handle("github"));
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [
    sparkWasmVitePlugin(),
    editorDevDeployHooksPlugin(),
    {
      name: "manifest-draft-bridge",
      configureServer(server) {
        server.middlewares.use("/__manifest-draft", (req, res, next) => {
          const cors = () => {
            const origin = req.headers.origin;
            if (origin && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
              res.setHeader("Access-Control-Allow-Origin", origin);
            } else {
              res.setHeader("Access-Control-Allow-Origin", "http://localhost:5175");
            }
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
          };
          if (req.method === "OPTIONS") {
            cors();
            res.statusCode = 204;
            res.end();
            return;
          }
          cors();
          if (req.method === "GET") {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
            res.end(manifestDraftStore ?? "null");
            return;
          }
          if (req.method === "POST") {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
              try {
                manifestDraftStore = body || null;
                res.statusCode = 200;
                res.end(JSON.stringify({ ok: true }));
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "Invalid JSON" }));
              }
            });
            return;
          }
          next();
        });
      },
    },
    {
      name: "manifest-file-api",
      configureServer(server) {
        // Single source of truth: editor reads/writes the viewer's manifest directly.
        // Avoids drift between apps/editor/public/manifest.json and apps/viewer/public/manifest.json.
        const manifestPath = viewerManifestPath;

        // GET: read manifest fresh from disk (bypasses Vite static file cache)
        server.middlewares.use("/__load-manifest", (req, res, next) => {
          if (req.method !== "GET") return next();
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
          try {
            if (fs.existsSync(manifestPath)) {
              const data = fs.readFileSync(manifestPath, "utf-8");
              res.end(data);
            } else {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "manifest.json not found" }));
            }
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(err) }));
          }
        });

        // POST: save manifest to disk
        server.middlewares.use("/__save-manifest", (req, res, next) => {
          if (req.method === "OPTIONS") {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.method !== "POST") return next();
          let body = "";
          req.on("data", (chunk) => { body += chunk; });
          req.on("end", () => {
            try {
              const data = JSON.parse(body || "{}");
              if (!data.models || !Array.isArray(data.models) || data.models.length === 0) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "Invalid manifest" }));
                return;
              }
              const jsonStr = JSON.stringify(data, null, 2);
              // manifestPath === viewerManifestPath: single write to the shared source of truth.
              fs.writeFileSync(manifestPath, jsonStr, "utf-8");
              // Also update the in-memory draft store for live sync
              manifestDraftStore = jsonStr;
              const modelCount = data?.models?.length ?? 0;
              const hasDealership = !!data?.dealership;
              console.log(`[save-manifest] Saved ${modelCount} models, dealership=${hasDealership}, bytes=${jsonStr.length}`);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, path: "public/manifest.json", modelCount, hasDealership }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });
      },
    },
    {
      name: "serve-splats-manifest",
      configureServer(server) {
        server.middlewares.use("/__splats-manifest", (req, res, next) => {
          if (req.method !== "GET") return next();
          const manifest = discoverManifestFromSplats(repoSplatsDir);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
          res.end(JSON.stringify(manifest ?? { version: 1, defaults: { modelId: "", colorId: "", view: "exterior" }, models: [] }));
        });
      },
    },
    {
      name: "serve-viewer-splats",
      configureServer(server) {
        server.middlewares.use("/splats", (req, res, next) => {
          const url = req.url || "/";
          const relPath = url.replace(/^\//, "").split("?")[0];
          const fullPath = path.resolve(repoSplatsDir, relPath);
          const safePath = path.relative(repoSplatsDir, fullPath);
          if (safePath.startsWith("..") || path.isAbsolute(safePath)) {
            next();
            return;
          }
          if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
            res.statusCode = 404;
            res.end("Not Found");
            return;
          }
          fs.createReadStream(fullPath).pipe(res);
        });
      },
    },
  ],
  resolve: {
    dedupe: ["three"],
    alias: [
      { find: "@changan/shared", replacement: path.resolve(__dirname, "../../packages/shared/src/index.ts") },
      {
        find: "@changan/scene-runtime/contactShadow",
        replacement: path.resolve(__dirname, "../../packages/scene-runtime/src/contactShadow.ts"),
      },
      {
        find: "@changan/scene-runtime",
        replacement: path.resolve(__dirname, "../../packages/scene-runtime/src/SceneRuntime.ts"),
      },
    ],
  },
  optimizeDeps: {
    entries: [
      "src/main.ts",
      path.resolve(__dirname, "../../packages/scene-runtime/src/SceneRuntime.ts"),
    ],
    esbuildOptions: {
      plugins: [sparkWasmEsbuildPlugin],
    },
  },
  server: {
    port: 5174,
    fs: {
      allow: [
        __dirname,
        path.resolve(__dirname, "../.."),
        path.resolve(__dirname, "../../packages"),
        path.resolve(__dirname, "../../node_modules"),
        path.resolve(__dirname, "../../assets/splats"),
      ],
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
