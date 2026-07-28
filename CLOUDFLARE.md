# Desplegar en Cloudflare Pages + R2

## URLs del showroom y del editor

| Qué | Nombre del proyecto (Workers & Pages) | URL pública típica |
|-----|----------------------------------------|----------------------|
| Showroom | `changan-showroom` | `https://spark-viewer-7rz.pages.dev` (dominio `*.pages.dev` del dashboard; puede diferir del nombre del proyecto) |
| Editor | `spark-viewer-editor` | `https://spark-viewer-editor.pages.dev` |

**Si en el dashboard no aparece el editor:** el listado solo muestra proyectos que existen en la cuenta. Créalo y despliega una vez: `pnpm run pages:create:editor` y `pnpm run pages:deploy:editor` (permiso **Cloudflare Pages → Edit**). Tras el primer deploy, en **Workers & Pages** → **spark-viewer-editor** → **Visit site** / **Domains** verás la URL `*.pages.dev`.

**Atajo directo al proyecto** (sustituye `ACCOUNT_ID` por el de tu cuenta, barra lateral del dashboard):  
`https://dash.cloudflare.com/ACCOUNT_ID/pages/view/spark-viewer-editor`

El showroom puede mostrar un enlace “Editor” si en el build del viewer defines **`VITE_PUBLIC_EDITOR_URL`** (ver [`apps/viewer/.env.production`](apps/viewer/.env.production)).

---

Los archivos bajo `assets/splats/` **no** se empaquetan en el build del viewer (límite [25 MiB por archivo en Pages](https://developers.cloudflare.com/pages/platform/limits/#file-size)). Se sirven desde **R2** con URL pública; la app usa `VITE_PUBLIC_ASSETS_BASE` para prefijar las rutas `/splats/...` del manifiesto.

## Listo en tu cuenta

- **KV** `spark-viewer-manifest` → id en [`apps/viewer/wrangler.toml`](apps/viewer/wrangler.toml) (binding `MANIFEST_KV`).

## 0. Habilitar R2 (una vez por cuenta)

Si la API o Wrangler devuelven **403** / *"Please enable R2 through the Cloudflare Dashboard"*:

1. Abre [R2 en el dashboard](https://dash.cloudflare.com/?to=/:account/r2/overview).
2. Acepta términos / activa el producto (puede pedir un método de pago aunque exista [capa gratuita](https://developers.cloudflare.com/r2/pricing/)).

Sin este paso, no se pueden crear buckets ni subir objetos.

## 1. Bucket, CORS, r2.dev y sync (en tu máquina)

En la raíz del repo, con **Wrangler autenticado** (`wrangler login` o variable `CLOUDFLARE_API_TOKEN` con permisos **Account → Workers R2 Storage → Edit**):

```bash
export R2_BUCKET=spark-viewer-splats   # opcional; este es el valor por defecto del script
pnpm run r2:bootstrap
```

Si el bucket **ya existe** en el dashboard pero Wrangler falla en `bucket info` / `create` (p. ej. error `/memberships`), salta ese paso y aplica solo URL pública + CORS + (opcional) sync:

```bash
export R2_BUCKET=changan
pnpm run r2:bootstrap:existing-bucket
```

O solo `dev-url` + CORS: `pnpm run r2:configure` (con `R2_BUCKET` exportado).

Eso ejecuta:

1. [`scripts/r2-provision.sh`](scripts/r2-provision.sh) — crea el bucket si no existe, **`wrangler r2 bucket dev-url enable`** (URL pública tipo `https://pub-….r2.dev`), y aplica CORS desde [`config/r2-cors.json`](config/r2-cors.json) (`GET`, `HEAD`, origen `*`, cabecera `range`).
2. [`scripts/sync-splats-r2.sh`](scripts/sync-splats-r2.sh) — sube `assets/splats/**` con claves `splats/...`.

Por separado: `pnpm run r2:provision` solo bucket + r2.dev + CORS; `pnpm run sync:splats:r2` solo subida (requiere `R2_BUCKET`).

### `VITE_PUBLIC_ASSETS_BASE` en Cloudflare Pages (Build)

Tras `r2:provision`, el script imprime la salida de `wrangler r2 bucket dev-url get <bucket>`. Usa la URL **`https://pub-….r2.dev`** que muestre Wrangler **sin barra final** como **`VITE_PUBLIC_ASSETS_BASE`** en el proyecto Pages del **viewer** (y del **editor** si aplica), en variables de **entorno de build**.

**En este repo** también están versionados [`apps/viewer/.env.production`](apps/viewer/.env.production) y [`apps/editor/.env.production`](apps/editor/.env.production) con la base R2 del despliegue actual (`changan`). Vite las carga en `vite build`, así que los builds locales y **Pages conectado a Git** ya reciben la URL sin tocar el dashboard. Si cambias de bucket o regeneras la URL pública, actualiza esos archivos (o sobreescribe con una variable de build en Pages).

Comprueba en el navegador: `https://pub-….r2.dev/splats/<algún-archivo.sog>` debe devolver el binario (o 404 si la clave no coincide).

### CORS más estricto

Si no quieres `AllowedOrigins: *`, copia [`config/r2-cors.strict.example.json`](config/r2-cors.strict.example.json), sustituye el origen de Pages y ejecuta:

`pnpm --filter viewer exec wrangler r2 bucket cors set "$R2_BUCKET" --file=config/r2-cors.strict.json`

### COEP / CORP

El showroom envía `Cross-Origin-Embedder-Policy: require-corp` ([`_headers`](apps/viewer/public/_headers)). Si el navegador **bloquea** la carga de splats desde `*.r2.dev`, las respuestas deben incluir **`Cross-Origin-Resource-Policy: cross-origin`**. R2 no siempre lo añade; opciones:

- Regla **Transform Response Headers** en Cloudflare para el hostname público que sirve R2 (p. ej. custom domain conectado al bucket), o
- Probar en DevTools; si con CORS basta, no hace falta cambiar nada.

## 2. Proyecto Pages — showroom (`viewer`)

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → conecta el repositorio Git (o **Direct Upload**).
2. **Build settings** (monorepo en la raíz del repo):
   - **Root directory**: vacío (raíz del repo).
   - **Build command**: `corepack enable && corepack prepare pnpm@9.0.0 --activate && pnpm install && pnpm run build:viewer`
   - **Build output directory**: `apps/viewer/dist`
   - **Environment variables** (Build): `NODE_VERSION` = `20`, `PNPM_VERSION` = `9`
3. **Variables de build** (mismo panel o **Settings → Environment variables** para *Build*):
   - **`VITE_PUBLIC_ASSETS_BASE`**: URL pública del bucket **sin** barra final, desde la que `GET {base}/splats/...` devuelve el objeto (ej. `https://pub-xxxxx.r2.dev` si ese host sirve las claves `splats/...` en la raíz; verifica con una URL de prueba en el navegador).
   - **`VITE_PUBLIC_EDITOR_URL`** (opcional): URL del editor Pages, p. ej. `https://spark-viewer-editor.pages.dev` — muestra el enlace **Editor** arriba a la derecha en el showroom.
4. Si el dashboard ofrece **Wrangler configuration file**, usa: `apps/viewer/wrangler.toml`.
5. Si no, tras el primer deploy: **Settings** → **Functions** → **KV namespace bindings** → **Add** → variable **`MANIFEST_KV`** → namespace **spark-viewer-manifest**.

### Variables de runtime (Settings → Variables and Secrets)

| Variable | Descripción |
|----------|-------------|
| `ACCESS_TEAM_DOMAIN` | `tuequipo.cloudflareaccess.com` (sin `https://`) |
| `ACCESS_AUD` | Application Audience (AUD) de la app Access del showroom |
| `ALLOWED_EDITOR_EMAILS` | Tu correo (varios: separados por coma) |
| `ALLOWED_CORS_ORIGINS` | Orígenes del editor, ej. `https://tu-editor.pages.dev,http://localhost:5174` |
| `MANIFEST_SAVE_SECRET` | (Opcional) Mismo valor que `VITE_MANIFEST_SAVE_SECRET` en el editor |

## 3. Proyecto Pages — editor

Nombre del proyecto usado en Wrangler: **`spark-viewer-editor`** → URL por defecto **`https://spark-viewer-editor.pages.dev`**.

### Crear el proyecto y desplegar (CLI)

Con `CLOUDFLARE_API_TOKEN` (permiso **Account → Cloudflare Pages → Edit**) y, si hace falta, `CLOUDFLARE_ACCOUNT_ID`:

```bash
pnpm run pages:create:editor    # una sola vez (falla si el nombre ya existe; entonces solo deploy)
pnpm run pages:deploy:editor
```

Configuración en repo: [`apps/editor/wrangler.toml`](apps/editor/wrangler.toml). Orígenes y R2 para el build: [`apps/editor/.env.production`](apps/editor/.env.production) (`VITE_VIEWER_API_ORIGIN` debe ser la URL base del viewer en **Domains** del proyecto `changan-showroom`, sin barra final).

En el **viewer** (Functions / variables), incluye el origen del editor en **`ALLOWED_CORS_ORIGINS`** para **guardar** manifiesto (POST) con cookies o orígenes explícitos, p. ej. `https://spark-viewer-editor.pages.dev,http://localhost:5174`. La **lectura** de `GET /api/manifest` también funciona con `Access-Control-Allow-Origin: *` cuando la lista está vacía, para que el editor cargue la misma escena que el showroom.

**Importante:** en `apps/editor/.env.production`, **`VITE_VIEWER_API_ORIGIN`** debe ser exactamente la URL base del viewer que ves en el dashboard (sin `/` final). Si Cloudflare asignó un sufijo (`*.pages.dev` distinto al nombre corto del proyecto), úsalo aquí o el editor no obtendrá el manifiesto.

### Si conectas Git en lugar de CLI

- **Build command**: `corepack enable && corepack prepare pnpm@9.0.0 --activate && pnpm install && pnpm run build:editor`
- **Build output directory**: `apps/editor/dist`
- **Wrangler configuration file**: `apps/editor/wrangler.toml`
- **Variables de build** (si no confías en `.env.production` versionado):
  - `VITE_VIEWER_API_ORIGIN` = URL del showroom (sin `/` final)
  - **`VITE_PUBLIC_ASSETS_BASE`** = la misma base R2 que el viewer
  - Opcional: `VITE_MANIFEST_SAVE_SECRET`

En **desarrollo local**, Vite sirve `/splats` desde [`assets/splats`](assets/splats) **solo si tienes los `.sog` en disco** (no vienen con el clone; están en R2). Sin archivos locales, usa `VITE_PUBLIC_ASSETS_BASE` apuntando a R2 o copia los binarios desde el bucket.

## 4. Cloudflare Access

- Crea una aplicación **Self-hosted** para el hostname del **editor** y otra (o políticas de ruta) para el **showroom** según quieras público o no.
- Copia el **AUD** de la aplicación que protege el tráfico hacia el origen donde corren las Functions del viewer a `ACCESS_AUD`.

## 5. Deploy manual con Wrangler (alternativa a Git)

Desde la **raíz del monorepo** (recomendado: usa metadatos de git seguros si aún no hay commits):

```bash
pnpm run pages:deploy:viewer
pnpm run pages:deploy:editor
```

Por dentro llaman a [`scripts/pages-wrangler-deploy.sh`](scripts/pages-wrangler-deploy.sh), que pasa `--branch`, `--commit-hash` y `--commit-message` para evitar `fatal: ambiguous argument 'HEAD'` cuando el repo es `git init` pero **no tiene ningún commit**.

**Rama de producción en Pages (secretos / chat):** En despliegues **directos** (`wrangler pages deploy`), Cloudflare marca el despliegue como **Production** solo si el valor de `--branch` coincide con **`production_branch`** del proyecto. Si no coincide, va a **Preview** (otro conjunto de variables y secretos).

- **Valor de `--branch`:** por defecto el script usa [`config/cloudflare-pages-deploy-branch`](config/cloudflare-pages-deploy-branch) (en este repo: `main`). Puedes forzar otro nombre con `PAGES_DEPLOY_BRANCH=nombre`.
- **Alinear el proyecto en Cloudflare (recomendado en CI o una vez en local):** exporta `CLOUDFLARE_API_TOKEN` con permiso **Account → Cloudflare Pages → Edit**. El script hace `PATCH` del proyecto y fija `production_branch` al mismo nombre que `--branch`. El **account id** se rellena solo con `wrangler whoami --json` si no defines `CLOUDFLARE_ACCOUNT_ID`.
- **Sin token API (solo `wrangler login`):** en el dashboard, **Workers & Pages** → tu proyecto → **Settings** → **Builds & deployments** → **Production branch** = el mismo valor que en `config/cloudflare-pages-deploy-branch` (p. ej. `main`). En proyectos **solo direct upload** a veces no aparece el campo; en ese caso crea un token con **Pages → Edit** y deja que el script haga el `PATCH`, o abre un ticket con Cloudflare.
- Si necesitas secretos solo en Preview mientras tanto: `wrangler pages secret put ... --env preview`.

Si prefieres Wrangler directo:

```bash
cd apps/viewer
pnpm build
pnpm exec wrangler pages deploy dist --project-name=changan-showroom
```

Crea antes el proyecto: `pnpm exec wrangler pages project create changan-showroom` (o renómbralo en el dashboard; `pnpm run pages:deploy:viewer` ya usa `changan-showroom`).

**Editor** (misma idea, desde la raíz del repo):

```bash
pnpm run pages:create:editor
pnpm run pages:deploy:editor
```

## 6. Cabeceras COOP/COEP

[`apps/viewer/public/_headers`](apps/viewer/public/_headers) configura aislamiento para Spark/WASM en Pages.

## 7. Git y modelos 3DGS

Los **`.sog` no están en Git** (`.gitignore`). La referencia en producción es **R2** (`VITE_PUBLIC_ASSETS_BASE`). Para poblar o actualizar el bucket: `pnpm run sync:splats:r2` (y `R2_BUCKET` si aplica). En local, copia los binarios a [`assets/splats`](assets/splats) si quieres `pnpm dev` sin R2 — ver [`assets/splats/README.md`](assets/splats/README.md).

Los commits antiguos del repo pueden seguir conteniendo binarios grandes; para purgar el historial en GitHub usa herramientas tipo [`git filter-repo`](https://github.com/newren/git-filter-repo) o un repo nuevo.
