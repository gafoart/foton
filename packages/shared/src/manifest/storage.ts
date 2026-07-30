import { validateManifestSafe } from "./validate.js";
import type { SceneManifest } from "./types.js";

export const MANIFEST_STORAGE_KEY = "foton-splat-manifest-draft";

export function loadManifestFromStorage(
  key: string = MANIFEST_STORAGE_KEY
): SceneManifest | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw) as unknown;
    const result = validateManifestSafe(data);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
