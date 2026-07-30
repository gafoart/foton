# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace layout

pnpm monorepo (`pnpm-workspace.yaml`, `packageManager: pnpm@9.0.0`). Two apps share two internal packages:

- `apps/viewer` — production Cloudflare Pages app (mobile-first showroom). Cloudflare Pages Functions live in `apps/viewer/functions/` (`api/manifest.ts`, `api/manifest-draft.ts`, `api/chat.ts`, plus `_middleware.ts` and `lib/auth.ts`/`cors.ts`). Bundled with Vite; `wrangler.toml` binds `MANIFEST_KV` and `ASSETS`.
- `apps/editor` — internal alignment / bookmark / annotation tool (Vite, port 5174). In `pnpm dev:editor` only, the right panel exposes **Deploy to Cloudflare** and **Push to GitHub** buttons that POST to local Vite middleware which shells out to `pnpm run pages:deploy:*` and `scripts/editor-git-push.sh` respectively (gated by optional `EDITOR_DEPLOY_SECRET`/`VITE_EDITOR_DEPLOY_SECRET` header).
- `packages/shared` (`@changan/shared`) — manifest types (`SceneManifest`, `ModelDef`, `AssetDef`, `TransformDef`, `NamedCameraBookmark`, …), Zod validators (`validateManifest`/`validateManifestSafe`), color/contact-shadow defaults, asset-key helpers, env helpers (`viewerApiBaseUrl`, `useRemoteManifestApi`, `resolveSplatAssetUrl`).
- `packages/scene-runtime` (`@changan/scene-runtime`) — `SceneRuntime` (Three.js + Spark + OrbitControls bootstrap), `FreeLookController`, `clearOrbitControlsTransientState`, scene-appearance helpers (lights/fog/background/blackdrop tint), and a `./contactShadow` subpath export for the editor.

Both apps alias `@changan/shared` and `@changan/scene-runtime` directly to source via Vite (`apps/*/vite.config.ts`) and via `paths` in their `tsconfig.json`. There is no build step for the internal packages — TS is compiled per-app.

## Common commands

Run from the repo root unless noted.

```bash
node scripts/setup.mjs             # first time per machine (Windows + macOS); enables corepack, pins pnpm, installs
pnpm install                       # subsequent installs once corepack is active
pnpm dev:viewer                    # viewer at http://localhost:5175 (Vite host:true for phones on LAN)
pnpm dev:editor                    # editor at http://localhost:5174
pnpm dev                           # both in parallel
pnpm build                         # tsc -b + vite build for every workspace package
pnpm build:viewer                  # single app
pnpm build:editor
pnpm lint                          # tsc --noEmit per package (no ESLint configured)
pnpm --filter viewer exec tsc --noEmit   # type-check just the viewer
```

Cloudflare deploys (require `wrangler` authenticated; see `CLOUDFLARE.md`):

```bash
pnpm run pages:deploy:viewer       # build + wrangler pages deploy → project foton-showroom
pnpm run pages:create:editor       # one-time create of project foton-editor (pages:create:viewer for the viewer)
pnpm run pages:deploy:editor
pnpm --filter viewer run pages:dev # build + wrangler pages dev (locally tests Functions)
```

The account has multiple Cloudflare accounts — deploys need `CLOUDFLARE_ACCOUNT_ID=6561c2988564601de317b813a35d5ffb` (Dev@gafoart.com) exported when wrangler runs non-interactively.

R2 (3DGS asset bucket; default `foton`, public URL `https://pub-57dba95d5e42405eb49421305a3d16c3.r2.dev`):

```bash
pnpm run r2:provision              # create bucket + enable r2.dev URL + apply CORS
pnpm run sync:splats:r2            # upload assets/splats/** with key prefix splats/
pnpm run r2:bootstrap              # provision + sync
pnpm run r2:bootstrap:existing-bucket  # skip create (R2_SKIP_BUCKET_ENSURE=1) when bucket already exists
```

There is no test runner configured — `pnpm lint` is `tsc --noEmit`.

## Cross-platform conventions

The repo is developed on both Windows and macOS. Things to keep aligned:

- `.gitattributes` enforces LF for source files and CRLF for `.ps1`/`.cmd`/`.bat` so checkouts don't reformat each other. Don't override `core.autocrlf` per-file — let attributes drive.
- `node_modules` is OS-specific (esbuild/rollup native binaries differ across `darwin-arm64`, `darwin-x64`, `win32-x64`). After switching machines or pulling lockfile changes, re-run `node scripts/setup.mjs` or `pnpm install`.
- The `.bin` shims that pnpm writes inside `node_modules/.bin` are also OS-specific (Unix `#!/bin/sh` on macOS, `.cmd` wrappers on Windows). Never commit them or anything under `node_modules` — pnpm regenerates them per OS.
- `scripts/*.sh` are POSIX shell. They run natively on macOS; on Windows they require Git Bash (provides `bash.exe` on PATH) or WSL. The `package.json` deploy scripts call them via `bash scripts/<name>.sh`.
- `scripts/setup.mjs` is the cross-platform bootstrap (Node, no shell). It uses `corepack.cmd` on Windows and `corepack` elsewhere.

## Manifest is the contract

`SceneManifest` (`packages/shared/src/manifest/types.ts`) is the single source of truth for the viewer and editor. The default scene ships in `manifest.json` at the repo root; the JSON Schema is `manifest.schema.json` (regenerate with `node scripts/generate-manifest-schema.mjs`, which derives it from the Zod schema and also writes `packages/shared/src/manifest/schema.json`). The viewer also serves a versioned copy from `apps/viewer/public/manifest.json`.

FOTON model structure: each `ModelDef` has `base` (bare vehicle splat), `accessories[]` (attachments shown **one at a time** on top of the base — the viewer's accessory selector picks which), optional `motor` and `interior` splats, and optional `nameplate3d` (per-model GLB `splats/<id>/<id>.glb`). `colors` is a dormant concept (`{id,name}` only) — the viewer's paint/color-grade system stays in the codebase but only activates when a model declares colors. Splat file convention per model folder: `<id>.sog` base, `<id>-motor.sog`, `<id>-int.sog`, any other `<id>-<suffix>.sog` is an accessory, `<id>.glb` nameplate (see `assets/splats/README.md`). Camera bookmarks store visibility per layer kind (`base`/`accessory`/`motor`/`interior`); the `accessory` flag applies to whichever accessory is currently selected.

In production the viewer's `GET /api/manifest` returns the manifest stored in `MANIFEST_KV` (key `manifest`) and falls back to the bundled `public/manifest.json` if KV is empty. The editor saves via `POST /api/manifest` (auth gated by Cloudflare Access — see `functions/lib/auth.ts`); it publishes a draft via `POST /api/manifest-draft` for the showroom dev bridge. Locally, the editor's Vite middleware exposes `/__load-manifest`, `/__save-manifest`, `/__manifest-draft`, and `/__splats-manifest`.

When changing manifest shape: update `types.ts`, the Zod validator in `validate.ts`, and the JSON schema; re-validate both apps' default `manifest.json` files. Both apps import the same types and validators — keeping them in sync is the whole point of `@changan/shared`.

## Spark / WebGL gotchas baked into the build

- **WASM data URI patch.** Spark embeds its WASM module as a base64 data URI inside `spark.module.js`, which Vite refuses to load. Both viewer and editor `vite.config.ts` install matching esbuild (pre-bundle) and Vite-transform (`enforce: "pre"`) plugins that rewrite that URL to `new URL("/spark_bg.wasm", import.meta.url)`. The actual WASM lives in `apps/*/public/spark_bg.wasm`. Don't remove the patch when upgrading `@sparkjsdev/spark` — verify both rewrite paths still match the new bundle's data-URI shape.
- **WebGLRenderer is created with `antialias: false`** in `SceneRuntime` — Spark requirement; do not flip it on.
- **Cross-origin isolation.** The viewer ships `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (Vite dev server headers and `apps/viewer/public/_headers` for Pages). Splats served from R2 may need a Transform Response Headers rule adding `Cross-Origin-Resource-Policy: cross-origin` if the browser blocks them; CORS alone usually suffices.
- **Splat asset paths.** The manifest stores asset URLs as `/splats/...`. In the browser, `resolveSplatAssetUrl` (in `@changan/shared`) prefixes them with `VITE_PUBLIC_ASSETS_BASE` (R2 public URL, no trailing slash) when set. In `pnpm dev:viewer`, a custom Vite middleware in `apps/viewer/vite.config.ts` serves `/splats/*` from `assets/splats/` if the file exists locally — so the viewer works offline only when you've copied the binaries from R2.
- **`.sogs` files must load via URL**, not bytes (Spark constraint). `AssetManager` already routes by extension; respect it when adding loaders.
- **Camera modes.** `NamedCameraBookmark.cameraMode` is `"orbit"` (default) or `"freelook"` (fixed eye, drag to look around — used for interiors). The viewer's render loop (`apps/viewer/src/main.ts`) installs `onTick`/`onAfterControlsUpdate`/`shouldSkipControlsUpdate` callbacks on `SceneRuntime` to suppress `OrbitControls.update()` when free-look is active, then re-applies orbit zoom limits from the active bookmark each frame so they don't drift.

## Cloudflare Pages projects (do not rename casually)

- Viewer project: **`foton-showroom`** (`https://foton-showroom.pages.dev`).
- Editor project: **`foton-editor`** (`https://foton-editor.pages.dev`).
- `config/cloudflare-pages-deploy-branch` (default: `main`) is the value `scripts/pages-wrangler-deploy.sh` passes as `--branch` and PATCHes onto the project's `production_branch`. Keep them aligned, otherwise direct uploads land in **Preview** and don't see production secrets.
- KV namespace `foton-manifest` (`143594c2dc71417f9b3e5299d23ae841`) is bound as `MANIFEST_KV` in `apps/viewer/wrangler.toml`.

## 3DGS assets are not in Git

`assets/splats/**/*.sog` and `*.ply` are gitignored. Production reads them from the `foton` R2 bucket: the viewer through its same-origin `/r2/*` Pages Function proxy (`VITE_PUBLIC_ASSETS_BASE=/r2`, edge-cached), the editor through the viewer's absolute proxy URL (`apps/*/​.env.production` are versioned so Pages builds work without dashboard env vars). Use `pnpm run sync:splats:r2` to upload, `R2_BUCKET=<name>` to override. For local dev without R2, copy the `.sog` files into `assets/splats/` manually.

## Chatbot Pages Function

`functions/api/chat.ts` calls OpenAI server-side using `OPENAI_API_KEY` (secret) and `OPENAI_MODEL` (default `gpt-4o-mini`). Knowledge files live in `apps/viewer/public/knowledge/` (`changan.txt` + one per model) and are read at request time. Set the secret with `wrangler pages secret put OPENAI_API_KEY --project-name=foton-showroom`. In `pnpm dev:viewer`, `viteChatDevPlugin.ts` reads `OPENAI_API_KEY` from `apps/viewer/.env.local`, then repo-root `.env.local`, then shell env. With `pnpm pages:dev`, use `apps/viewer/.dev.vars`.

## Editor → viewer auth

The viewer's `/api/manifest` POST is protected by Cloudflare Access (JWT verified in `functions/lib/auth.ts` against `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` / `ALLOWED_EDITOR_EMAILS`). CORS is gated by `ALLOWED_CORS_ORIGINS` (`functions/lib/cors.ts`); GET reads are public when the list is empty. When the editor runs at a new origin, add it to `ALLOWED_CORS_ORIGINS` in the viewer's Pages env. The editor picks viewer base URL via `VITE_VIEWER_API_ORIGIN` and toggles between local (`/__*`) and remote (`/api/*`) endpoints with `useRemoteManifestApi()`.
