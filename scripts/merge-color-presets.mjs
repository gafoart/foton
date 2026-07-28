#!/usr/bin/env node
/**
 * Merge per-color Photoshock grade presets into one `{model}_color.json` per
 * model folder, the file the viewer loads (single fetch per model; color
 * switches read from it without further requests).
 *
 *   assets/splats/<model>/<model>_<color>_color.json   (inputs, kept on disk)
 *   assets/splats/<model>/<model>_color.json           (output)
 *
 * Re-run after re-exporting any color from Photoshock:
 *   node scripts/merge-color-presets.mjs
 *
 * Tolerates the underscore model spelling in filenames (hunter_g_grey_color.json
 * inside hunter-g/). "white" never has a preset — the white body is the base.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const splatsDir = path.join(repoRoot, "assets", "splats");

const modelDirs = fs
  .readdirSync(splatsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let totalModels = 0;
for (const model of modelDirs) {
  const dir = path.join(splatsDir, model);
  const altModel = model.replace(/-/g, "_");
  const re = new RegExp(
    `^(?:${escapeRe(model)}|${escapeRe(altModel)})_([a-z0-9]+)_color\\.json$`,
    "i"
  );

  const colors = {};
  for (const file of fs.readdirSync(dir).sort()) {
    const m = re.exec(file);
    if (!m) continue;
    const colorId = m[1].toLowerCase();
    try {
      const preset = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      colors[colorId] = preset;
    } catch (e) {
      console.error(`  SKIP ${model}/${file}: ${e.message}`);
    }
  }

  const colorIds = Object.keys(colors);
  if (colorIds.length === 0) continue;

  const out = {
    type: "photoshock-color-grade-set",
    version: 1,
    model,
    updatedAt: new Date().toISOString(),
    colors,
  };
  const outPath = path.join(dir, `${model}_color.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  totalModels++;
  console.log(`${model}: ${colorIds.length} colors (${colorIds.join(", ")}) -> ${path.relative(repoRoot, outPath)}`);
}

console.log(`\nDone: ${totalModels} model set(s) written.`);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
