import type { ViewMode } from "@changan/shared";

const VIEW_LABELS: Record<ViewMode, string> = {
  exterior: "Exterior",
  detail: "Detail",
  interior: "Interior",
};

export interface ViewToggleOptions {
  selected: ViewMode;
  onSelect: (view: ViewMode) => void;
}

export function createViewToggle({
  selected,
  onSelect,
}: ViewToggleOptions): HTMLElement {
  const el = document.createElement("div");
  el.className = "view-toggle";

  const label = document.createElement("span");
  label.className = "picker-label";
  label.textContent = "View";
  el.appendChild(label);

  const buttons = document.createElement("div");
  buttons.className = "view-buttons";

  const modes: ViewMode[] = ["exterior", "detail", "interior"];
  for (const view of modes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "view-btn";
    btn.textContent = VIEW_LABELS[view];
    btn.dataset.view = view;
    if (view === selected) btn.classList.add("selected");
    btn.addEventListener("click", () => onSelect(view));
    buttons.appendChild(btn);
  }
  el.appendChild(buttons);

  return el;
}
