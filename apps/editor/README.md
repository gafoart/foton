# Spark viewer — web editor

- **Local:** http://localhost:5174 (`pnpm dev:editor` desde la raíz del monorepo)
- **Producción (Cloudflare Pages):** proyecto **`spark-viewer-editor`** → **`https://spark-viewer-editor.pages.dev`** (tras `pnpm run pages:create:editor` y `pnpm run pages:deploy:editor`)

Más detalle: [`CLOUDFLARE.md`](../../CLOUDFLARE.md) (sección *Proyecto Pages — editor*).

## Publish (solo `pnpm dev:editor`)

En el panel derecho aparecen **Deploy to Cloudflare** y **Push to GitHub** (solo en modo desarrollo). Ejecutan comandos en tu máquina a través del servidor Vite:

- **Cloudflare:** guarda el manifiesto y luego `pnpm run pages:deploy:viewer` + `pages:deploy:editor` (hace falta `wrangler` autenticado). Junto al botón hay **↗** para abrir en una pestaña la URL de Pages del editor para `main` (por defecto `https://spark-viewer-editor.pages.dev`; configurable con `VITE_CF_PAGES_EDITOR_MAIN_URL` en `.env.local`).
- **GitHub:** guarda el manifiesto y luego [`scripts/editor-git-push.sh`](../../scripts/editor-git-push.sh) (`git add -A`, commit con mensaje automático, `git push origin HEAD`).

Opcional: define `EDITOR_DEPLOY_SECRET` al arrancar Vite y `VITE_EDITOR_DEPLOY_SECRET` en `.env.local` del editor con el mismo valor; el cliente enviará la cabecera `X-Editor-Deploy-Secret`.
