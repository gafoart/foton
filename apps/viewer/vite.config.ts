import { defineConfig, type Plugin } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { chatDevApiPlugin } from "./viteChatDevPlugin.ts";
import { feedbackDevApiPlugin } from "./viteFeedbackDevPlugin.ts";
import { knowledgeDevApiPlugin } from "./viteKnowledgeDevPlugin.ts";
import { chatProfileDevPlugin } from "./viteChatProfileDevPlugin.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const WASM_DATA_URI_RE = /new URL\(\s*"data:application\/wasm[^"]+"\s*,\s*import\.meta\.url\s*\)/g;
const WASM_REPLACEMENT = 'new URL("/spark_bg.wasm", import.meta.url)';

/**
 * Spark embeds its WASM as a ~12KB base64 data URI in spark.module.js.
 * Vite can't handle `new URL("data:...", import.meta.url)` — it tries to
 * use the data URI as a file path and fails (ENAMETOOLONG / 404).
 *
 * We serve the WASM as public/spark_bg.wasm instead and patch the reference
 * in two places:
 *  1. esbuild plugin — fixes it during dep pre-bundling
 *  2. Vite transform plugin — fixes it when the raw file is served directly
 *     (happens when packages/scene-runtime resolves @sparkjsdev/spark via its
 *     own local node_modules symlink instead of the pre-bundled dep)
 */
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

function serveRepoSplatsPlugin(): Plugin {
  return {
    name: "serve-repo-splats",
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
  };
}

/**
 * Vite serves multi-page inputs by their filename (`/linkgen.html`), but
 * Cloudflare Pages resolves the bare `/<name>` path to `<name>.html` for
 * us in production. This middleware mirrors that behaviour during dev so
 * the URL the user types matches what they'll share.
 */
const PRETTY_URL_ROUTES = ["linkgen", "product", "ia"];
function prettyUrlPlugin(): Plugin {
  return {
    name: "pretty-url-rewrite",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        const [pathOnly, query = ""] = url.split("?");
        const slug = pathOnly.replace(/^\/+|\/+$/g, "");
        if (PRETTY_URL_ROUTES.includes(slug)) {
          req.url = `/${slug}.html${query ? `?${query}` : ""}`;
        }
        next();
      });
    },
  };
}

/**
 * Dev stub for /api/me — Vite doesn't run Pages Functions so the real
 * handler is unreachable; without this the SPA fallback returns index.html
 * and the admin pages' hydration code silently bails. Reporting "auth not
 * enabled" matches the production behaviour when `SESSION_SIGNING_SECRET`
 * is unset, which is the same state as local dev.
 */
function authMeDevPlugin(): Plugin {
  return {
    name: "auth-me-dev",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/api/me") return next();
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ enabled: false }));
      });
    },
  };
}

function hdriListPlugin(appRoot: string): Plugin {
  const hdriDir = path.join(appRoot, "public/hdri");
  return {
    name: "hdri-list-dev",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/__hdri-list") return next();
        let files: string[] = [];
        try {
          files = fs.readdirSync(hdriDir).filter((f: string) => /\.(hdr|exr|jpg|jpeg|png|webp)$/i.test(f)).sort();
        } catch { /* dir may not exist */ }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(files));
      });
    },
  };
}

export default defineConfig({
  plugins: [
    sparkWasmVitePlugin(),
    serveRepoSplatsPlugin(),
    prettyUrlPlugin(),
    authMeDevPlugin(),
    chatDevApiPlugin(__dirname),
    feedbackDevApiPlugin(__dirname),
    knowledgeDevApiPlugin(__dirname),
    chatProfileDevPlugin(__dirname),
    hdriListPlugin(__dirname),
  ],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        linkgen: path.resolve(__dirname, "linkgen.html"),
        product: path.resolve(__dirname, "product.html"),
        ia: path.resolve(__dirname, "ia.html"),
      },
    },
  },
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
    // Scan SceneRuntime so Vite discovers @sparkjsdev/spark through the alias path
    entries: [
      "src/main.ts",
      path.resolve(__dirname, "../../packages/scene-runtime/src/SceneRuntime.ts"),
    ],
    esbuildOptions: {
      plugins: [sparkWasmEsbuildPlugin],
    },
  },
  server: {
    port: 5175,
    /** Listen on all interfaces so phones on the same Wi‑Fi can open the dev server. */
    host: true,
    fs: {
      // Vite's default allow list is replaced when set manually, so we must
      // re-add the app root and workspace root alongside packages/
      allow: [
        __dirname,                                          // apps/viewer/
        path.resolve(__dirname, "../.."),                   // workspace root
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
