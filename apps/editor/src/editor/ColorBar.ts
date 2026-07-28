import { resolveSwatchHex } from "@changan/shared";

export interface ColorBarOptions {
  getColors: (modelId: string) => { id: string; name: string }[];
  getModelId: () => string;
  getActiveColorId: () => string;
  onColorSelect: (colorId: string) => void;
}

export function createColorBar(options: ColorBarOptions): {
  el: HTMLElement;
  refresh: () => void;
} {
  const { getColors, getModelId, getActiveColorId, onColorSelect } = options;

  const wrapper = document.createElement("div");
  wrapper.className = "color-bar-wrapper";

  const swatchesRow = document.createElement("div");
  swatchesRow.className = "color-bar-swatches-float";
  wrapper.appendChild(swatchesRow);

  function refresh(): void {
    const modelId = getModelId();
    const colors = getColors(modelId);
    const active = getActiveColorId();

    swatchesRow.innerHTML = "";

    if (colors.length <= 1) {
      wrapper.style.display = "none";
      return;
    }
    wrapper.style.display = "";

    for (const c of colors) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "color-bar-swatch" + (active === c.id ? " active" : "");
      btn.style.backgroundColor = resolveSwatchHex(modelId, c.id);
      btn.title = c.name;
      btn.setAttribute("aria-label", c.name);
      btn.addEventListener("click", () => onColorSelect(c.id));
      swatchesRow.appendChild(btn);
    }
  }

  return { el: wrapper, refresh };
}
