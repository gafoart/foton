import type { ColorDef } from "@changan/shared";

export interface ColorPickerOptions {
  colors: ColorDef[];
  selectedId: string;
  onSelect: (colorId: string) => void;
}

const COLOR_SWATCHES: Record<string, string> = {
  red: "#c41e3a",
  whitepearl: "#f5f5dc",
  black: "#1a1a1a",
  blue: "#0066aa",
  silver: "#c0c0c0",
  gray: "#808080",
};

function getSwatchColor(colorId: string): string {
  return COLOR_SWATCHES[colorId.toLowerCase()] ?? "#888";
}

export function createColorPicker({
  colors,
  selectedId,
  onSelect,
}: ColorPickerOptions): HTMLElement {
  const el = document.createElement("div");
  el.className = "color-picker";

  const label = document.createElement("span");
  label.className = "picker-label";
  label.textContent = "Color";
  el.appendChild(label);

  const swatches = document.createElement("div");
  swatches.className = "color-swatches";
  for (const c of colors) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "color-swatch";
    btn.title = c.name;
    btn.style.backgroundColor = getSwatchColor(c.id);
    btn.dataset.colorId = c.id;
    if (c.id === selectedId) btn.classList.add("selected");
    btn.addEventListener("click", () => onSelect(c.id));
    swatches.appendChild(btn);
  }
  el.appendChild(swatches);

  return el;
}
