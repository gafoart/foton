import type { NamedCameraBookmark } from "@changan/shared";

export interface BookmarkNavigatorOptions {
  getBookmarks: () => NamedCameraBookmark[];
  getCurrentIndex: () => number;
  onNavigate: (index: number) => void;
}

export function createBookmarkNavigator(options: BookmarkNavigatorOptions): {
  el: HTMLElement;
  refresh: () => void;
} {
  const { getBookmarks, getCurrentIndex, onNavigate } = options;

  const container = document.createElement("div");
  container.className = "bookmark-navigator";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "bookmark-navigator-arrow";
  prevBtn.innerHTML = "‹";
  prevBtn.title = "Previous bookmark";

  const nameSpan = document.createElement("span");
  nameSpan.className = "bookmark-navigator-name";

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "bookmark-navigator-arrow";
  nextBtn.innerHTML = "›";
  nextBtn.title = "Next bookmark";

  container.appendChild(prevBtn);
  container.appendChild(nameSpan);
  container.appendChild(nextBtn);

  prevBtn.addEventListener("click", () => {
    const list = getBookmarks();
    const idx = getCurrentIndex();
    if (list.length === 0) return;
    const prevIdx = idx <= 0 ? list.length - 1 : idx - 1;
    onNavigate(prevIdx);
  });

  nextBtn.addEventListener("click", () => {
    const list = getBookmarks();
    const idx = getCurrentIndex();
    if (list.length === 0) return;
    const nextIdx = idx >= list.length - 1 ? 0 : idx + 1;
    onNavigate(nextIdx);
  });

  function refresh(): void {
    const list = getBookmarks();
    const idx = getCurrentIndex();
    prevBtn.disabled = list.length === 0;
    nextBtn.disabled = list.length === 0;
    if (list.length > 0 && idx >= 0 && idx < list.length) {
      nameSpan.textContent = list[idx].name;
      nameSpan.title = list[idx].name;
    } else {
      nameSpan.textContent = list.length === 0 ? "No bookmarks" : "";
      nameSpan.title = "";
    }
  }

  return { el: container, refresh };
}
