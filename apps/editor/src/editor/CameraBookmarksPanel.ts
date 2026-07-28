import type { NamedCameraBookmark } from "@changan/shared";
import type { ActiveAssetType } from "./EditorRuntime.js";

export interface CameraBookmarksPanelOptions {
  getModelName: () => string;
  getBookmarks: () => NamedCameraBookmark[];
  getCurrentCamera: () => { pos: [number, number, number]; target: [number, number, number] };
  getCurrentConstraints?: () => { azimuthMin: number; azimuthMax: number; polarMin: number; polarMax: number };
  getCurrentDoF?: () => { focalDistance: number; apertureSize: number };
  getCurrentLens?: () => { fov: number; minDistance: number; maxDistance?: number };
  getVisibility: (asset: ActiveAssetType) => boolean;
  onAdd: (
    name: string,
    pos: [number, number, number],
    target: [number, number, number],
    visibility: Record<ActiveAssetType, boolean>,
    constraints?: { azimuthMin?: number; azimuthMax?: number; polarMin?: number; polarMax?: number },
    dof?: { focalDistance?: number; apertureSize?: number },
    lens?: { fov?: number; minDistance?: number; maxDistance?: number }
  ) => void;
  onRemove: (id: string) => void;
  onApply: (bookmark: NamedCameraBookmark) => void;
  onUpdate: (
    id: string,
    updates: Partial<{
      name: string;
      pos: [number, number, number];
      target: [number, number, number];
    }>
  ) => void;
  /** Move bookmark one row up (-1) or down (+1). */
  onReorder: (id: string, direction: -1 | 1) => void;
  onSelectionChange?: (id: string | null) => void;
}

export function createCameraBookmarksPanel(options: CameraBookmarksPanelOptions): {
  el: HTMLElement;
  refresh: () => void;
  getSelectedBookmarkId: () => string | null;
  setSelectedBookmarkId: (id: string | null) => void;
} {
  const {
    getModelName,
    getBookmarks,
    getCurrentCamera,
    getVisibility,
    getCurrentConstraints,
    getCurrentDoF,
    getCurrentLens,
    onAdd,
    onRemove,
    onApply,
    onUpdate,
    onReorder,
    onSelectionChange,
  } = options;

  const panel = document.createElement("div");
  panel.className = "camera-bookmarks-panel";

  const header = document.createElement("div");
  header.className = "camera-bookmarks-panel-header";
  const title = document.createElement("span");
  title.className = "camera-bookmarks-panel-title";
  header.appendChild(title);

  function updateHeader(): void {
    const modelName = getModelName();
    title.textContent = modelName ? `Camera (${modelName})` : "Camera";
    title.title = "Bookmarks for this model";
  }
  updateHeader();

  const body = document.createElement("div");
  body.className = "camera-bookmarks-panel-body";

  const addRow = document.createElement("div");
  addRow.className = "camera-bookmarks-add-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Bookmark name";
  nameInput.className = "camera-bookmarks-name-input";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "camera-bookmarks-add-btn";
  addBtn.textContent = "+ Add";
  addBtn.title = "Save current camera & layer visibility";
  addRow.appendChild(nameInput);
  addRow.appendChild(addBtn);

  const list = document.createElement("div");
  list.className = "camera-bookmarks-list";

  panel.appendChild(header);
  panel.appendChild(body);
  body.appendChild(addRow);
  body.appendChild(list);

  addBtn.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const { pos, target } = getCurrentCamera();
    const visibility: Record<ActiveAssetType, boolean> = {
      exterior: getVisibility("exterior"),
      detail: getVisibility("detail"),
      interior: getVisibility("interior"),
    };
    onAdd(
      name,
      pos,
      target,
      visibility,
      getCurrentConstraints?.(),
      getCurrentDoF?.(),
      getCurrentLens?.()
    );
    nameInput.value = "";
    renderList();
  });

  function createNumInput(
    value: number,
    onChange: (v: number) => void
  ): HTMLInputElement {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "any";
    inp.value = String(value);
    inp.className = "camera-bookmarks-num-input";
    const commit = () => {
      const parsed = parseFloat(inp.value);
      if (!Number.isNaN(parsed)) onChange(parsed);
    };
    inp.addEventListener("change", commit);
    inp.addEventListener("blur", commit);
    return inp;
  }

  let expandedId: string | null = null;

  function renderList(): void {
    list.innerHTML = "";
    const bookmarks = getBookmarks();
    bookmarks.forEach((bm, index) => {
      const row = document.createElement("div");
      row.className = "camera-bookmarks-list-item" + (expandedId === bm.id ? " selected" : "");
      row.dataset.id = bm.id;

      const topRow = document.createElement("div");
      topRow.className = "camera-bookmarks-list-top";

      const reorder = document.createElement("div");
      reorder.className = "camera-bookmarks-reorder";
      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "camera-bookmarks-reorder-btn";
      upBtn.textContent = "↑";
      upBtn.title = "Move up";
      upBtn.disabled = index === 0;
      upBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onReorder(bm.id, -1);
      });
      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "camera-bookmarks-reorder-btn";
      downBtn.textContent = "↓";
      downBtn.title = "Move down";
      downBtn.disabled = index >= bookmarks.length - 1;
      downBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onReorder(bm.id, 1);
      });
      reorder.append(upBtn, downBtn);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "camera-bookmarks-rename-input";
      nameInput.value = bm.name;
      nameInput.title = "Bookmark name";
      nameInput.placeholder = "Name";
      const commitName = () => {
        const next = nameInput.value.trim();
        if (!next) {
          nameInput.value = bm.name;
          return;
        }
        if (next !== bm.name) onUpdate(bm.id, { name: next });
      };
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameInput.blur();
        }
      });
      nameInput.addEventListener("blur", commitName);
      nameInput.addEventListener("click", (e) => e.stopPropagation());

      const actions = document.createElement("div");
      actions.className = "camera-bookmarks-list-actions";

      const goBtn = document.createElement("button");
      goBtn.type = "button";
      goBtn.className = "camera-bookmarks-go-btn";
      goBtn.textContent = "Go";
      goBtn.title = "Apply this bookmark";
      goBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        expandedId = bm.id; // select this bookmark when applying
        onSelectionChange?.(bm.id);
        onApply(bm);
        renderList();
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "camera-bookmarks-del-btn";
      delBtn.textContent = "✕";
      delBtn.title = "Delete bookmark";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onRemove(bm.id);
        renderList();
      });

      actions.appendChild(goBtn);
      actions.appendChild(delBtn);
      topRow.appendChild(reorder);
      topRow.appendChild(nameInput);
      topRow.appendChild(actions);
      row.appendChild(topRow);

      const isExpanded = expandedId === bm.id;
      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "camera-bookmarks-expand-btn";
      expandBtn.textContent = isExpanded ? "▼ Pivot" : "▶ Pivot";
      expandBtn.title = "Edit camera position and pivot (orbit center)";
      expandBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        expandedId = isExpanded ? null : bm.id;
        onSelectionChange?.(expandedId);
        renderList();
      });
      row.appendChild(expandBtn);

      if (isExpanded) {
        const editSection = document.createElement("div");
        editSection.className = "camera-bookmarks-edit-section";

        const pivotLabel = document.createElement("div");
        pivotLabel.className = "camera-bookmarks-edit-label";
        pivotLabel.textContent = "Pivot (orbit center)";
        editSection.appendChild(pivotLabel);

        const pivotRow = document.createElement("div");
        pivotRow.className = "camera-bookmarks-edit-row";
        const getCurrent = () => getBookmarks().find((b) => b.id === bm.id) ?? bm;
        const targetX = createNumInput(bm.target[0], (v) => {
          const cur = getCurrent();
          onUpdate(bm.id, { target: [v, cur.target[1], cur.target[2]] });
        });
        const targetY = createNumInput(bm.target[1], (v) => {
          const cur = getCurrent();
          onUpdate(bm.id, { target: [cur.target[0], v, cur.target[2]] });
        });
        const targetZ = createNumInput(bm.target[2], (v) => {
          const cur = getCurrent();
          onUpdate(bm.id, { target: [cur.target[0], cur.target[1], v] });
        });
        targetX.placeholder = "X";
        targetY.placeholder = "Y";
        targetZ.placeholder = "Z";
        pivotRow.append(targetX, targetY, targetZ);
        editSection.appendChild(pivotRow);

        const posLabel = document.createElement("div");
        posLabel.className = "camera-bookmarks-edit-label";
        posLabel.textContent = "Camera position";
        editSection.appendChild(posLabel);

        const posRow = document.createElement("div");
        posRow.className = "camera-bookmarks-edit-row";
        const getCurrentPos = () => getBookmarks().find((b) => b.id === bm.id) ?? bm;
        const posX = createNumInput(bm.pos[0], (v) => {
          const cur = getCurrentPos();
          onUpdate(bm.id, { pos: [v, cur.pos[1], cur.pos[2]] });
        });
        const posY = createNumInput(bm.pos[1], (v) => {
          const cur = getCurrentPos();
          onUpdate(bm.id, { pos: [cur.pos[0], v, cur.pos[2]] });
        });
        const posZ = createNumInput(bm.pos[2], (v) => {
          const cur = getCurrentPos();
          onUpdate(bm.id, { pos: [cur.pos[0], cur.pos[1], v] });
        });
        posX.placeholder = "X";
        posY.placeholder = "Y";
        posZ.placeholder = "Z";
        posRow.append(posX, posY, posZ);
        editSection.appendChild(posRow);

        const setFromCurrentBtn = document.createElement("button");
        setFromCurrentBtn.type = "button";
        setFromCurrentBtn.className = "camera-bookmarks-set-btn";
        setFromCurrentBtn.textContent = "Set from current";
        setFromCurrentBtn.title = "Copy current camera position and pivot";
        setFromCurrentBtn.addEventListener("click", () => {
          const { pos, target } = getCurrentCamera();
          onUpdate(bm.id, { pos, target });
          renderList();
        });
        editSection.appendChild(setFromCurrentBtn);

        row.appendChild(editSection);
      }

      list.appendChild(row);
    });
  }

  function refresh(): void {
    updateHeader();
    renderList();
  }

  function getSelectedBookmarkId(): string | null {
    return expandedId;
  }

  function setSelectedBookmarkId(id: string | null): void {
    expandedId = id;
    onSelectionChange?.(id);
    renderList();
  }

  return { el: panel, refresh, getSelectedBookmarkId, setSelectedBookmarkId };
}
