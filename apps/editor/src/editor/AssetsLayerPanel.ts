import type { SplatLayerKind } from "@changan/shared";

export interface AssetLayerInfo {
  url: string;
  label: string;
  kind: SplatLayerKind;
  /** Set when `kind === "accessory"`. */
  accessoryId?: string;
  /** Optional `{modelId}.glb` 3D nameplate row (not a splat asset). */
  isNameplate3d?: boolean;
  /** Manifest-driven floor shadow disk (not a splat URL). */
  isContactShadow?: boolean;
}

const VISIBILITY_STORAGE_KEY = "changan-editor-layer-visibility";
const PANEL_COLLAPSED_KEY = "changan-editor-layer-panel-collapsed";
const GROUP_COLLAPSED_KEY = "changan-editor-layer-group-collapsed";
const GROUP_VISIBILITY_KEY = "changan-editor-layer-group-visibility";

function loadVisibility(modelId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Record<string, Record<string, boolean>>;
    const model = data[modelId];
    return model ?? {};
  } catch {
    return {};
  }
}

function saveVisibility(modelId: string, visibility: Record<string, boolean>): void {
  try {
    const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    const data: Record<string, Record<string, boolean>> = raw ? JSON.parse(raw) : {};
    data[modelId] = visibility;
    localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

function loadGroupCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveGroupCollapsed(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(GROUP_COLLAPSED_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function loadGroupVisibility(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_VISIBILITY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveGroupVisibility(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(GROUP_VISIBILITY_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function loadPanelCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(PANEL_COLLAPSED_KEY);
    return raw === "true";
  } catch {
    return false;
  }
}

function savePanelCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(PANEL_COLLAPSED_KEY, String(collapsed));
  } catch {
    // ignore
  }
}

export interface ModelInfo {
  id: string;
  name: string;
}

export function createAssetsLayerPanel(options: {
  models: ModelInfo[];
  initialModelId: string;
  getAssetLayers: (modelId: string) => AssetLayerInfo[];
  getActiveLayer: () => AssetLayerInfo | null;
  onSelect: (modelId: string, layer: AssetLayerInfo) => void;
  onVisibilityChange: (modelId: string, layer: AssetLayerInfo, visible: boolean) => void;
}): {
  el: HTMLElement;
  setActive: (modelId: string, layer: AssetLayerInfo) => void;
  setVisibility: (modelId: string, layer: AssetLayerInfo, visible: boolean, persist?: boolean) => void;
  getVisibility: (modelId: string, layer: AssetLayerInfo) => boolean;
  getVisibilityByKind: (modelId: string, kind: SplatLayerKind) => boolean;
  ensureGroupVisible: (modelId: string) => void;
  resetToBaseOnly: (modelId: string, alsoShow?: AssetLayerInfo) => void;
  refresh: () => void;
  refreshVisibility: () => void;
} {
  const { models, initialModelId, getAssetLayers, getActiveLayer, onSelect, onVisibilityChange } = options;
  let activeModelId = initialModelId;
  let activeLayer: AssetLayerInfo | null = null;
  let groupCollapsed = loadGroupCollapsed();
  let groupVisibility = loadGroupVisibility();

  const panel = document.createElement("div");
  panel.className = "assets-layer-panel";

  const header = document.createElement("div");
  header.className = "assets-layer-panel-header";
  const title = document.createElement("span");
  title.className = "assets-layer-panel-title";
  title.textContent = "Layers";
  const collapseBtn = document.createElement("button");
  collapseBtn.className = "assets-layer-panel-collapse";
  collapseBtn.title = "Collapse panel";
  collapseBtn.innerHTML = "◀";
  collapseBtn.setAttribute("aria-label", "Collapse layers panel");
  header.appendChild(title);
  header.appendChild(collapseBtn);

  const body = document.createElement("div");
  body.className = "assets-layer-panel-body";

  const modelsLabel = document.createElement("div");
  modelsLabel.className = "assets-layer-models-label";
  modelsLabel.textContent = "Models";
  body.appendChild(modelsLabel);

  /** `visible` mirrors the eye icon — the state the user SEES (bookmark masks
   *  update it via setVisibility without persisting), so a toggle always flips
   *  relative to what's on screen. */
  type RowState = { row: HTMLElement; eyeBtn: HTMLElement; label: HTMLElement; visible: boolean };
  const rowsByModel: Record<string, Record<string, RowState>> = {};
  const groupEyeBtns: Record<string, HTMLButtonElement> = {};

  models.forEach((model) => {
    const group = document.createElement("div");
    group.className = "assets-layer-group";
    group.dataset.modelId = model.id;

    const groupHeader = document.createElement("div");
    groupHeader.className = "assets-layer-group-header";
    const groupEyeBtn = document.createElement("button");
    groupEyeBtn.className = "assets-layer-eye assets-layer-group-eye";
    groupEyeBtns[model.id] = groupEyeBtn;
    const groupVisible = groupVisibility[model.id] !== false;
    groupEyeBtn.innerHTML = groupVisible
      ? '<span class="eye-icon" aria-hidden="true">👁</span>'
      : '<span class="eye-icon eye-hidden" aria-hidden="true">👁</span>';
    groupEyeBtn.title = groupVisible ? "Hide group" : "Show group";
    groupEyeBtn.setAttribute("aria-label", groupVisible ? "Hide group" : "Show group");
    const chevron = document.createElement("span");
    chevron.className = "assets-layer-group-chevron";
    chevron.textContent = groupCollapsed[model.id] ? "▶" : "▼";
    const groupLabel = document.createElement("span");
    groupLabel.className = "assets-layer-group-label";
    groupLabel.textContent = model.name;
    groupHeader.appendChild(groupEyeBtn);
    groupHeader.appendChild(chevron);
    groupHeader.appendChild(groupLabel);

    const groupBody = document.createElement("div");
    groupBody.className = "assets-layer-group-body";
    if (groupCollapsed[model.id]) {
      groupBody.classList.add("collapsed");
    }

    groupEyeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nextVisible = groupVisibility[model.id] === false;
      groupVisibility[model.id] = nextVisible;
      saveGroupVisibility(groupVisibility);
      groupEyeBtn.innerHTML = nextVisible
        ? '<span class="eye-icon" aria-hidden="true">👁</span>'
        : '<span class="eye-icon eye-hidden" aria-hidden="true">👁</span>';
      groupEyeBtn.title = nextVisible ? "Hide group" : "Show group";
      const vis = loadVisibility(model.id);
      for (const layer of getAssetLayers(model.id)) {
        onVisibilityChange(model.id, layer, (vis[layer.url] !== false) && nextVisible);
      }
    });

    groupHeader.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".assets-layer-eye")) return;
      if (activeModelId !== model.id) {
        ensureGroupVisible(model.id);
        activeModelId = model.id;
        const layers = getAssetLayers(model.id);
        activeLayer = layers[0] ?? null;
        if (activeLayer) onSelect(model.id, activeLayer);
        groupCollapsed[model.id] = false;
        saveGroupCollapsed(groupCollapsed);
        groupBody.classList.remove("collapsed");
        chevron.textContent = "▼";
        updateActiveState();
      } else {
        const isCollapsed = groupCollapsed[model.id] ?? false;
        groupCollapsed[model.id] = !isCollapsed;
        saveGroupCollapsed(groupCollapsed);
        groupBody.classList.toggle("collapsed", groupCollapsed[model.id]);
        chevron.textContent = groupCollapsed[model.id] ? "▶" : "▼";
      }
    });

    group.appendChild(groupHeader);
    group.appendChild(groupBody);
    body.appendChild(group);
  });

  function renderModelLayers(modelId: string): void {
    const layers = getAssetLayers(modelId);
    const group = body.querySelector(`.assets-layer-group[data-model-id="${modelId}"]`);
    const groupBody = group?.querySelector(".assets-layer-group-body") as HTMLElement;
    const existingRows = groupBody?.querySelectorAll(".assets-layer-row");
    if (!groupBody) return;

    existingRows?.forEach((r) => r.remove());
    const visibility = loadVisibility(modelId);
    const modelRows = rowsByModel[modelId] ?? {};
    for (const k of Object.keys(modelRows)) delete modelRows[k];

    for (const layer of layers) {
      const row = document.createElement("div");
      row.className = "assets-layer-row assets-layer-row-nested";
      row.dataset.url = layer.url;
      row.dataset.modelId = modelId;

      const eyeBtn = document.createElement("button");
      eyeBtn.className = "assets-layer-eye";
      const vis = visibility[layer.url] !== false;
      eyeBtn.title = vis ? "Hide" : "Show";
      eyeBtn.innerHTML = vis
        ? '<span class="eye-icon" aria-hidden="true">👁</span>'
        : '<span class="eye-icon eye-hidden" aria-hidden="true">👁</span>';

      const label = document.createElement("span");
      label.className = "assets-layer-label";
      label.textContent = layer.label;

      row.appendChild(eyeBtn);
      row.appendChild(label);
      groupBody.appendChild(row);
      const rowState: RowState = { row, eyeBtn, label, visible: vis };
      modelRows[layer.url] = rowState;

      eyeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const nextVis = !rowState.visible;
        rowState.visible = nextVis;
        const stored = loadVisibility(modelId);
        stored[layer.url] = nextVis;
        saveVisibility(modelId, stored);
        onVisibilityChange(modelId, layer, nextVis && (groupVisibility[modelId] !== false));
        eyeBtn.innerHTML = nextVis
          ? '<span class="eye-icon" aria-hidden="true">👁</span>'
          : '<span class="eye-icon eye-hidden" aria-hidden="true">👁</span>';
        eyeBtn.title = nextVis ? "Hide" : "Show";
      });

      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".assets-layer-eye")) return;
        activeModelId = modelId;
        activeLayer = layer;
        onSelect(modelId, layer);
        updateActiveState();
      });
    }
    rowsByModel[modelId] = modelRows;
  }

  models.forEach((m) => renderModelLayers(m.id));

  panel.appendChild(header);
  panel.appendChild(body);

  const leftPanelWrapper = document.createElement("div");
  leftPanelWrapper.className = "editor-left-panel";
  leftPanelWrapper.appendChild(panel);

  function updateActiveState(): void {
    activeLayer = getActiveLayer();
    models.forEach((m) => {
      const layers = getAssetLayers(m.id);
      const modelRows = rowsByModel[m.id];
      if (!modelRows) return;
      for (const layer of layers) {
        const state = modelRows[layer.url];
        if (state) {
          state.row.classList.toggle(
            "active",
            m.id === activeModelId && activeLayer?.url === layer.url
          );
        }
      }
    });
  }

  let collapsed = loadPanelCollapsed();
  leftPanelWrapper.classList.toggle("collapsed", collapsed);

  collapseBtn.addEventListener("click", () => {
    collapsed = !collapsed;
    savePanelCollapsed(collapsed);
    leftPanelWrapper.classList.toggle("collapsed", collapsed);
    collapseBtn.innerHTML = collapsed ? "▶" : "◀";
    collapseBtn.title = collapsed ? "Expand panel" : "Collapse panel";
  });
  if (collapsed) {
    collapseBtn.innerHTML = "▶";
    collapseBtn.title = "Expand panel";
  }

  updateActiveState();

  function ensureGroupVisible(modelId: string): void {
    if (groupVisibility[modelId] !== false) return;
    groupVisibility[modelId] = true;
    saveGroupVisibility(groupVisibility);
    const btn = groupEyeBtns[modelId];
    if (btn) {
      btn.innerHTML = '<span class="eye-icon" aria-hidden="true">👁</span>';
      btn.title = "Hide group";
      btn.setAttribute("aria-label", "Hide group");
    }
  }

  /** Persist splat-layer visibility as "base only" (plus `alsoShow`, e.g. the row the
   *  user clicked). Nameplate / contact-shadow rows keep their stored state. */
  function resetToBaseOnly(modelId: string, alsoShow?: AssetLayerInfo): void {
    const vis = loadVisibility(modelId);
    for (const layer of getAssetLayers(modelId)) {
      if (layer.isNameplate3d || layer.isContactShadow) continue;
      const visible = layer.kind === "base" || layer.url === alsoShow?.url;
      vis[layer.url] = visible;
      const state = rowsByModel[modelId]?.[layer.url];
      if (state) {
        state.visible = visible;
        state.eyeBtn.innerHTML = visible
          ? '<span class="eye-icon" aria-hidden="true">👁</span>'
          : '<span class="eye-icon eye-hidden" aria-hidden="true">👁</span>';
        state.eyeBtn.title = visible ? "Hide" : "Show";
      }
    }
    saveVisibility(modelId, vis);
  }

  return {
    el: leftPanelWrapper,
    ensureGroupVisible,
    resetToBaseOnly,
    setActive: (modelId: string, layer: AssetLayerInfo) => {
      activeModelId = modelId;
      activeLayer = layer;
      updateActiveState();
    },
    setVisibility: (modelId: string, layer: AssetLayerInfo, visible: boolean, persist = false) => {
      const state = rowsByModel[modelId]?.[layer.url];
      if (!state) return;
      state.visible = visible;
      state.eyeBtn.innerHTML = visible
        ? '<span class="eye-icon">👁</span>'
        : '<span class="eye-icon eye-hidden">👁</span>';
      state.eyeBtn.title = visible ? "Hide" : "Show";
      if (persist) {
        const vis = loadVisibility(modelId);
        vis[layer.url] = visible;
        saveVisibility(modelId, vis);
      }
    },
    getVisibility: (modelId: string, layer: AssetLayerInfo) =>
      (loadVisibility(modelId)[layer.url] !== false) && (groupVisibility[modelId] !== false),
    getVisibilityByKind: (modelId: string, kind: SplatLayerKind) => {
      const layers = getAssetLayers(modelId).filter(
        (l) => l.kind === kind && !l.isNameplate3d && !l.isContactShadow
      );
      return layers.some((l) => loadVisibility(modelId)[l.url] !== false) && groupVisibility[modelId] !== false;
    },
    refresh: () => {
      models.forEach((m) => renderModelLayers(m.id));
      updateActiveState();
    },
    refreshVisibility: () => {
      models.forEach((m) => {
        const visibility = loadVisibility(m.id);
        const layers = getAssetLayers(m.id);
        for (const layer of layers) {
          const state = rowsByModel[m.id]?.[layer.url];
          if (state) {
            const vis = visibility[layer.url] !== false;
            state.visible = vis;
            state.eyeBtn.innerHTML = vis
              ? '<span class="eye-icon" aria-hidden="true">👁</span>'
              : '<span class="eye-icon eye-hidden" aria-hidden="true">👁</span>';
            state.eyeBtn.title = vis ? "Hide" : "Show";
          }
        }
      });
    },
  };
}
