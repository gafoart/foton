import type { ModelDef } from "@changan/shared";

export interface ModelPickerOptions {
  models: ModelDef[];
  selectedId: string;
  onSelect: (modelId: string) => void;
}

export function createModelPicker({
  models,
  selectedId,
  onSelect,
}: ModelPickerOptions): HTMLElement {
  const el = document.createElement("div");
  el.className = "model-picker";

  const label = document.createElement("span");
  label.className = "picker-label";
  label.textContent = "Model";
  el.appendChild(label);

  const select = document.createElement("select");
  select.className = "picker-select";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    if (m.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => onSelect(select.value));
  el.appendChild(select);

  return el;
}
