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

## Estructura de carpetas (convención de nombres FOTON)

Cada modelo tiene su subcarpeta. El **editor en local** auto-descubre modelos desde el disco con esta convención (separador `-` o `_`):

```
splats/
  <modelId>/                # e.g. 3t
    <modelId>.sog           # Modelo base (requerido)
    <modelId>-motor.sog     # Motor (opcional)
    <modelId>-int.sog       # Interior (opcional)
    <modelId>-<accesorio>.sog  # Accesorio — cualquier otro sufijo (furgon, tanque, …); uno visible a la vez sobre la base
    <modelId>.glb           # Nombre 3D (opcional)
```

Los sufijos `motor` e `int` están reservados; todo otro sufijo se registra como accesorio con ese id.

### Ejemplo (3t)

- `3t.sog` (base), `3t-furgon.sog` y `3t-tanque.sog` (accesorios), `3t-int.sog` (interior), `3t.glb` (nombre 3D)

## Formato de archivo

Por defecto el manifiesto usa `"fileType": "zip"` → **PCSOGSZIP**. Si el error indica zip inválido, revisa la exportación desde Spark o ajusta `fileType` (`ply`, `spz`, etc.) en el manifiesto.
