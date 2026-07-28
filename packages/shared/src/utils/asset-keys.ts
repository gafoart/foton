import type { ViewMode } from "../manifest/types.js";

/**
 * Asset key format for per-color views: {modelId}:{colorId}:{view}
 */
export function assetKey(
  modelId: string,
  colorId: string,
  view: "exterior" | "detail"
): string {
  return `${modelId}:${colorId}:${view}`;
}

/**
 * Asset key format for interior: {modelId}:interior
 */
export function interiorAssetKey(modelId: string): string {
  return `${modelId}:interior`;
}

/**
 * Check if view is a per-color view (exterior/detail) vs interior
 */
export function isPerColorView(view: ViewMode): view is "exterior" | "detail" {
  return view !== "interior";
}
