# Changan Multi-Model Gaussian Splat Showroom

Mobile-first web viewer for car splat assets with a web-based editor for alignment, camera bookmarks, and annotations.

## Stack

- **Spark** — 3D Gaussian Splatting for Three.js
- **Three.js** — 3D rendering
- **Vite** — Build tool
- **TypeScript** — Type safety
- **Zod** — Manifest validation

## Project Structure

```
├── apps/
│   ├── viewer/     # Production viewer (mobile-first)
│   └── editor/     # Internal editor (alignment, bookmarks, export)
├── packages/
│   ├── shared/     # Manifest types, validator, LRU cache, asset keys
│   └── scene-runtime/  # Three.js + Spark + OrbitControls scene
├── assets/splats/      # Solo estructura + README en Git; los .sog viven en Cloudflare R2
├── manifest.json       # Sample scene definition
└── manifest.schema.json # JSON Schema for manifest
```

**Modelos 3DGS:** no se suben a GitHub. Producción los sirve **R2** (`VITE_PUBLIC_ASSETS_BASE`). Subida: `pnpm run sync:splats:r2` — detalles en [`assets/splats/README.md`](assets/splats/README.md) y [`CLOUDFLARE.md`](CLOUDFLARE.md).

## Setup

First time on a machine (Windows or macOS):

```bash
node scripts/setup.mjs   # enables corepack, pins pnpm, runs pnpm install
```

After that, everything is `pnpm <cmd>`:

```bash
pnpm install             # idempotent re-install
```

### Cross-platform notes

- **Line endings** are normalized via [`.gitattributes`](.gitattributes) — source files are LF on every OS, `.ps1`/`.cmd`/`.bat` are CRLF. Switching machines does not produce diff noise.
- **`node_modules` is OS-specific** (esbuild and rollup ship native binaries). After cloning on a different OS — or after a teammate pushed a lockfile change — re-run `node scripts/setup.mjs` (or `pnpm install`) to swap them.
- **Windows users need Git Bash** (or WSL) on `PATH` for the deploy/sync helpers in [`scripts/`](scripts) — they are POSIX shell scripts (`pages-wrangler-deploy.sh`, `r2-provision.sh`, `sync-splats-r2.sh`, `editor-git-push.sh`). Git for Windows installs `bash.exe` automatically.

## Development

```bash
# Run viewer
pnpm dev:viewer

# Run editor
pnpm dev:editor
```

- **Viewer**: http://localhost:5173
- **Editor**: http://localhost:5174

## Build

```bash
pnpm build
```

## Cloudflare Pages (resumen)

Tras crear proyectos y desplegar con Wrangler (ver [`CLOUDFLARE.md`](CLOUDFLARE.md), incluye enlace al dashboard y tabla de URLs):

- **Viewer**: proyecto **`changan-showroom`** — URL `*.pages.dev` la indica el dashboard (p. ej. `https://spark-viewer-7rz.pages.dev` si Cloudflare no cambió el subdominio al renombrar)
- **Editor**: `https://spark-viewer-editor.pages.dev` (proyecto `spark-viewer-editor`)

Si el editor **no sale** en **Workers & Pages**, aún no existe el proyecto: `pnpm run pages:create:editor` y `pnpm run pages:deploy:editor` (token con **Cloudflare Pages → Edit**). El showroom incluye un enlace **Editor** (arriba a la derecha) cuando el build lleva `VITE_PUBLIC_EDITOR_URL` — ya va en [`apps/viewer/.env.production`](apps/viewer/.env.production).

## Manifest

The scene is defined by `manifest.json`:

- **models** — Car models with colors and assets (exterior, motor, trunk, interior)
- **bookmarks** — Camera positions per view
- **annotations** — Pinned labels with optional bookmark focus

Place your splat asset URLs in the manifest. Supported formats: `.ply`, `.spz`, `.splat`, `.ksplat`.

## Usage

**Viewer**: Switch model, color, and view (exterior/motor/trunk/interior). Annotations appear as pins; click to focus the linked bookmark.

**Editor**: Load manifest, select asset, use transform gizmos (W/E/R) to align, save bookmarks from current camera, export validated manifest.
