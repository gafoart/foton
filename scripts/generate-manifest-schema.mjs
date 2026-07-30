// Regenerates manifest.schema.json (repo root) and packages/shared/src/manifest/schema.json
// from the Zod schema in packages/shared/src/manifest/validate.ts.
// Usage: node scripts/generate-manifest-schema.mjs
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// esbuild/zod-to-json-schema live in workspace package deps, not the root (pnpm strict layout).
const requireFromViewer = createRequire(join(repoRoot, "apps/viewer/package.json"));
const requireFromShared = createRequire(join(repoRoot, "packages/shared/package.json"));
// esbuild is vite's dependency — resolve it from vite's own location.
const requireFromVite = createRequire(requireFromViewer.resolve("vite"));
const { build } = requireFromVite("esbuild");
const tmp = mkdtempSync(join(tmpdir(), "manifest-schema-"));
const outFile = join(tmp, "validate.mjs");

try {
  await build({
    entryPoints: [join(repoRoot, "packages/shared/src/manifest/validate.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: outFile,
  });

  const { sceneManifestSchema } = await import(pathToFileURL(outFile).href);
  const { zodToJsonSchema } = requireFromShared("zod-to-json-schema");

  const schema = zodToJsonSchema(sceneManifestSchema, { name: "SceneManifest" });
  const json = JSON.stringify(schema, null, 2) + "\n";

  writeFileSync(join(repoRoot, "manifest.schema.json"), json);
  writeFileSync(join(repoRoot, "packages/shared/src/manifest/schema.json"), json);
  console.log("Wrote manifest.schema.json and packages/shared/src/manifest/schema.json");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
