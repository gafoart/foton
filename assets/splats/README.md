# Splats (3DGS assets)

**Los archivos `.sog` no se versionan en Git.** La copia de referencia está en **Cloudflare R2** (mismo layout de claves `splats/<modelId>/...` que usa el showroom en producción).

## Subir o actualizar R2

Desde la raíz del monorepo (con Wrangler autenticado y `R2_BUCKET` si no usas el nombre por defecto):

```bash
export R2_BUCKET=changan   # tu bucket
pnpm run sync:splats:r2
```

Aprovisionar bucket / URL pública / CORS: `pnpm run r2:bootstrap` o `r2:bootstrap:existing-bucket` — ver [`CLOUDFLARE.md`](../../CLOUDFLARE.md).

La app en producción usa `VITE_PUBLIC_ASSETS_BASE` (URL `*.r2.dev` o custom domain) para resolver `/splats/...` del manifiesto.

## Desarrollo local

`pnpm dev:viewer` y `pnpm dev:editor` sirven **`assets/splats/`** con Vite solo si **tienes los `.sog` en disco** (cópialos desde R2, otro equipo, o sincroniza con un script propio). Si la carpeta está vacía, el showroom en local no cargará modelos hasta que añadas binarios.

## Estructura de carpetas (convención de nombres)

Cada modelo tiene su subcarpeta. El **editor en local** puede auto-descubrir modelos desde el disco con esta convención:

```
splats/
  <modelId>/                         # e.g. alsvin, cs55
    <modelId>_<color>_ext.sog       # Exterior
    <modelId>_<color>_motor.sog    # Motor/detail view
    <modelId>_int.sog              # Interior (one per car)
```

### Nombres requeridos para auto-discovery

- `{modelId}_int.sog` – interior  
- `{modelId}_{color}_ext.sog` – exterior  
- `{modelId}_{color}_motor.sog` – detail  

Cada color necesita **exterior y motor** para descubrirse.

### Ejemplo (Alsvin)

- `alsvin_white_ext.sog`, `alsvin_white_motor.sog`, `alsvin_int.sog`

## Formato de archivo

Por defecto el manifiesto usa `"fileType": "zip"` → **PCSOGSZIP**. Si el error indica zip inválido, revisa la exportación desde Spark o ajusta `fileType` (`ply`, `spz`, etc.) en el manifiesto.
