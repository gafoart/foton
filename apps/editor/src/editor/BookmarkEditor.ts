import type { CameraBookmark, ViewMode } from "@changan/shared";

export interface BookmarkEditorOptions {
  getCurrentBookmark: () => CameraBookmark;
  onSave: (view: ViewMode, bookmark: CameraBookmark) => void;
}

const VIEW_LABELS: Record<ViewMode, string> = {
  exterior: "Exterior",
  detail: "Detail",
  interior: "Interior",
};

export function createBookmarkEditorPanel({
  getCurrentBookmark,
  onSave,
}: BookmarkEditorOptions): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "bookmark-editor-panel";

  const title = document.createElement("h3");
  title.textContent = "Camera Bookmarks";
  panel.appendChild(title);

  const modes: ViewMode[] = ["exterior", "detail", "interior"];

  for (const view of modes) {
    const row = document.createElement("div");
    row.className = "bookmark-row";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `Save as ${VIEW_LABELS[view]}`;
    btn.addEventListener("click", () => {
      const bookmark = getCurrentBookmark();
      onSave(view, bookmark);
    });
    row.appendChild(btn);
    panel.appendChild(row);
  }

  return panel;
}
