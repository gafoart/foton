import { validateManifest, validateManifestSafe } from "@changan/shared";
import type { SceneManifest } from "@changan/shared";

export interface ExportResult {
  success: boolean;
  errors?: string[];
}

/**
 * Validate manifest and return result.
 */
export function validateForExport(manifest: SceneManifest): ExportResult {
  const result = validateManifestSafe(manifest);
  if (result.success) {
    return { success: true };
  }
  const errors = result.error.errors.map(
    (e) => `${e.path.join(".")}: ${e.message}`
  );
  return { success: false, errors };
}

/**
 * Export manifest as JSON string with pretty formatting.
 */
export function exportManifestJson(manifest: SceneManifest): string {
  validateManifest(manifest);
  return JSON.stringify(manifest, null, 2);
}

/**
 * Trigger download of manifest.json.
 */
export function downloadManifest(manifest: SceneManifest): ExportResult {
  const validation = validateForExport(manifest);
  if (!validation.success) return validation;

  const json = exportManifestJson(manifest);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "manifest.json";
  a.click();
  URL.revokeObjectURL(url);
  return { success: true };
}
