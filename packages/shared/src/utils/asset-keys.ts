import type { SplatLayerKind } from "../manifest/types.js";

/**
 * Uniform cache/scene key for a model's splat layer:
 * - `{modelId}:base` | `{modelId}:motor` | `{modelId}:interior`
 * - `{modelId}:accessory:{accessoryId}`
 */
export function splatLayerKey(
  modelId: string,
  kind: SplatLayerKind,
  accessoryId?: string
): string {
  if (kind === "accessory") {
    if (!accessoryId) {
      throw new Error("splatLayerKey: accessory layer requires an accessoryId");
    }
    return `${modelId}:accessory:${accessoryId}`;
  }
  return `${modelId}:${kind}`;
}

export interface ParsedSplatLayerKey {
  modelId: string;
  kind: SplatLayerKind;
  accessoryId?: string;
}

/** Inverse of {@link splatLayerKey}. Returns null for keys it doesn't own. */
export function parseSplatLayerKey(key: string): ParsedSplatLayerKey | null {
  const parts = key.split(":");
  if (parts.length === 2) {
    const [modelId, kind] = parts;
    if (kind === "base" || kind === "motor" || kind === "interior") {
      return { modelId, kind };
    }
    return null;
  }
  if (parts.length === 3 && parts[1] === "accessory" && parts[2]) {
    return { modelId: parts[0], kind: "accessory", accessoryId: parts[2] };
  }
  return null;
}
