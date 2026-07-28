/** Hex swatches for showroom/editor color dots (key = color id, lowercased). */
export const SHOWROOM_COLOR_SWATCH_HEX: Record<string, string> = {
  red: "#c41e3a",
  white: "#ffffff",
  whitepearl: "#f5f5dc",
  black: "#1a1a1a",
  blue: "#0066aa",
  silver: "#808080",
  gray: "#c0c0c0",
  grey: "#c0c0c0",
  blanco: "#ffffff",
  green: "#2d6a4f",
  yellow: "#e6c200",
  orange: "#e85d04",
  burgundy: "#722f37",
  brown: "#6b4423",
  gold: "#c9a227",
  beige: "#d4c4a8",
};

/** Per-model overrides keyed by model id, then color id (both lowercased). */
export const SHOWROOM_COLOR_SWATCH_HEX_BY_MODEL: Record<string, Record<string, string>> = {
  cs35: {
    silver: "#c0c0bf",
    gray: "#808081",
    grey: "#808081",
  },
};

export function resolveSwatchHex(modelId: string | undefined, colorId: string): string {
  const cid = colorId.toLowerCase();
  const mid = modelId?.toLowerCase();
  if (mid) {
    const override = SHOWROOM_COLOR_SWATCH_HEX_BY_MODEL[mid]?.[cid];
    if (override) return override;
  }
  return SHOWROOM_COLOR_SWATCH_HEX[cid] ?? "#888";
}

/** `white` first (if present), then alphabetical by id. */
export function sortColorsForShowroom<T extends { id: string }>(colors: T[]): T[] {
  return [...colors].sort((a, b) => {
    const aw = a.id.toLowerCase() === "white" ? 0 : 1;
    const bw = b.id.toLowerCase() === "white" ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return a.id.localeCompare(b.id);
  });
}

export function resolveDefaultColorId(colors: { id: string }[]): string {
  const w = colors.find((c) => c.id.toLowerCase() === "white");
  if (w) return w.id;
  return colors[0]?.id ?? "";
}

export function resolveDefaultColorIdForModel(
  model: { colors: { id: string }[] } | undefined,
  preferred: string | undefined
): string {
  if (!model?.colors?.length) return preferred ?? "";
  if (preferred && model.colors.some((c) => c.id === preferred)) return preferred;
  return resolveDefaultColorId(model.colors);
}
