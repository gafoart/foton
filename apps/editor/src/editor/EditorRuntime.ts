import type { SceneRuntime } from "@changan/scene-runtime";
import type { SplatMesh } from "@sparkjsdev/spark";
import type {
  SceneManifest,
  ViewMode,
  AssetDef,
  TransformDef,
  NamedCameraBookmark,
  CameraInteractionMode,
  SplatLayerKind,
} from "@changan/shared";

/** Identifies one editable splat layer of a model. */
export interface ActiveLayerRef {
  kind: SplatLayerKind;
  /** Required when `kind === "accessory"`. */
  accessoryId?: string;
}

export interface EditorState {
  modelId: string;
  activeLayer: ActiveLayerRef;
  mode: "transform" | "bookmark" | "annotation";
}

export interface EditorRuntimeOptions {
  runtime: SceneRuntime;
  manifest: SceneManifest;
  onManifestChange?: (manifest: SceneManifest) => void;
}

export class EditorRuntime {
  private runtime: SceneRuntime;
  private _manifest: SceneManifest;
  private onManifestChange?: (manifest: SceneManifest) => void;
  private _state: EditorState;
  private activeMesh: SplatMesh | null = null;

  constructor({
    runtime,
    manifest,
    onManifestChange,
  }: EditorRuntimeOptions) {
    this.runtime = runtime;
    this._manifest = manifest;
    this.onManifestChange = onManifestChange;
    this._state = {
      modelId: manifest.defaults.modelId,
      activeLayer: { kind: "base" },
      mode: "transform",
    };
  }

  get manifest(): SceneManifest {
    return this._manifest;
  }

  get state(): EditorState {
    return { ...this._state, activeLayer: { ...this._state.activeLayer } };
  }

  get runtimeRef(): SceneRuntime {
    return this.runtime;
  }

  get activeMeshRef(): SplatMesh | null {
    return this.activeMesh;
  }

  setActiveMesh(mesh: SplatMesh | null): void {
    this.activeMesh = mesh;
  }

  setModel(modelId: string): void {
    this._state.modelId = modelId;
    this._state.activeLayer = { kind: "base" };
  }

  setActiveLayer(layer: ActiveLayerRef): void {
    this._state.activeLayer = { ...layer };
  }

  getActiveAssetDef(): AssetDef | null {
    const { modelId, activeLayer } = this._state;
    const model = this._manifest.models.find((m) => m.id === modelId);
    if (!model) return null;
    switch (activeLayer.kind) {
      case "base":
        return model.base;
      case "motor":
        return model.motor ?? null;
      case "interior":
        return model.interior ?? null;
      case "accessory":
        return (
          model.accessories.find((a) => a.id === activeLayer.accessoryId)
            ?.asset ?? null
        );
    }
  }

  setMode(mode: EditorState["mode"]): void {
    this._state.mode = mode;
  }

  updateTransform(transform: TransformDef): void {
    const assetDef = this.getActiveAssetDef();
    if (!assetDef) return;
    assetDef.transform = { ...transform };
    this.onManifestChange?.(this._manifest);
  }

  updatePivot(pivot: [number, number, number], pivotRot?: [number, number, number, number]): void {
    const assetDef = this.getActiveAssetDef();
    if (!assetDef) return;
    assetDef.transform = {
      ...assetDef.transform,
      pivot: [...pivot],
      pivotRot: pivotRot ?? assetDef.transform.pivotRot ?? [0, 0, 0, 1],
    };
    this.onManifestChange?.(this._manifest);
  }

  resetCurrentTransform(): TransformDef | null {
    const assetDef = this.getActiveAssetDef();
    if (!assetDef) return null;
    const identity: TransformDef = {
      pos: [0, 0, 0],
      rot: [0, 0, 0, 1],
      scale: 1,
      pivot: [0, 0, 0],
      pivotRot: [0, 0, 0, 1],
    };
    assetDef.transform = { ...identity };
    this.onManifestChange?.(this._manifest);
    return identity;
  }

  updateBookmark(view: ViewMode, pos: [number, number, number], target: [number, number, number]): void {
    const model = this._manifest.models.find((m) => m.id === this._state.modelId);
    if (!model) return;
    if (!model.bookmarks) model.bookmarks = {};
    model.bookmarks[view] = { pos, target };
    this.onManifestChange?.(this._manifest);
  }

  getCameraBookmarks(): NamedCameraBookmark[] {
    const model = this._manifest.models.find((m) => m.id === this._state.modelId);
    return model?.cameraBookmarks ?? [];
  }

  addCameraBookmark(
    name: string,
    pos: [number, number, number],
    target: [number, number, number],
    visibility: Record<SplatLayerKind, boolean>,
    constraints?: { azimuthMin?: number; azimuthMax?: number; polarMin?: number; polarMax?: number },
    dof?: { focalDistance?: number; apertureSize?: number },
    lens?: { fov?: number; minDistance?: number; maxDistance?: number },
    cameraMode?: CameraInteractionMode
  ): NamedCameraBookmark {
    const model = this._manifest.models.find((m) => m.id === this._state.modelId);
    if (!model) throw new Error("No model selected");
    if (!model.cameraBookmarks) model.cameraBookmarks = [];
    const id = `cb-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const fin = (v: number | undefined, fallback: number): number =>
      v !== undefined && Number.isFinite(v) ? v : fallback;
    const bookmark: NamedCameraBookmark = {
      id,
      name,
      pos,
      target,
      visibility: { ...visibility },
      ...(constraints && {
        azimuthMin: fin(constraints.azimuthMin, -180),
        azimuthMax: fin(constraints.azimuthMax, 180),
        polarMin: fin(constraints.polarMin, 5),
        polarMax: fin(constraints.polarMax, 175),
      }),
      ...(dof && {
        focalDistance: fin(dof.focalDistance, 5),
        apertureSize: fin(dof.apertureSize, 0.1),
      }),
      ...(lens && {
        ...(lens.fov !== undefined && Number.isFinite(lens.fov) ? { fov: lens.fov } : {}),
        ...(lens.minDistance !== undefined && Number.isFinite(lens.minDistance)
          ? { minDistance: Math.max(0, lens.minDistance) }
          : {}),
        ...(lens.maxDistance !== undefined &&
        Number.isFinite(lens.maxDistance) &&
        lens.maxDistance > 0
          ? { maxDistance: lens.maxDistance }
          : {}),
      }),
      ...(cameraMode === "freelook" ? { cameraMode: "freelook" as const } : {}),
    };
    model.cameraBookmarks.push(bookmark);
    this.onManifestChange?.(this._manifest);
    return bookmark;
  }

  removeCameraBookmark(id: string): void {
    const model = this._manifest.models.find((m) => m.id === this._state.modelId);
    if (!model?.cameraBookmarks) return;
    model.cameraBookmarks = model.cameraBookmarks.filter((b) => b.id !== id);
    this.onManifestChange?.(this._manifest);
  }

  /** Move a named camera bookmark one slot up (-1) or down (+1) in the list order. */
  moveCameraBookmark(id: string, direction: -1 | 1): void {
    const model = this._manifest.models.find((m) => m.id === this._state.modelId);
    const list = model?.cameraBookmarks;
    if (!list || list.length < 2) return;
    const i = list.findIndex((b) => b.id === id);
    if (i < 0) return;
    const j = i + direction;
    if (j < 0 || j >= list.length) return;
    const tmp = list[i];
    list[i] = list[j]!;
    list[j] = tmp!;
    this.onManifestChange?.(this._manifest);
  }

  updateCameraBookmark(
    id: string,
    updates: Partial<{
      name: string;
      pos: [number, number, number];
      target: [number, number, number];
      visibility: Record<SplatLayerKind, boolean>;
      azimuthMin: number;
      azimuthMax: number;
      polarMin: number;
      polarMax: number;
      fov: number;
      minDistance: number;
      maxDistance: number;
      focalDistance: number;
      apertureSize: number;
      /** When true, remove maxDistance so zoom is unlimited in the viewer. */
      clearMaxDistance: boolean;
      /** When true, remove fov, minDistance, and maxDistance (runtime defaults). */
      clearLens: boolean;
      cameraMode?: CameraInteractionMode;
    }>
  ): void {
    const model = this._manifest.models.find((m) => m.id === this._state.modelId);
    const bm = model?.cameraBookmarks?.find((b) => b.id === id);
    if (!bm) return;
    if (updates.clearLens) {
      delete bm.fov;
      delete bm.minDistance;
      delete bm.maxDistance;
    }
    if (updates.name !== undefined) bm.name = updates.name;
    if (updates.pos !== undefined) bm.pos = [...updates.pos];
    if (updates.target !== undefined) bm.target = [...updates.target];
    if (updates.visibility !== undefined) Object.assign(bm.visibility, updates.visibility);
    if (updates.azimuthMin !== undefined && Number.isFinite(updates.azimuthMin)) bm.azimuthMin = updates.azimuthMin;
    if (updates.azimuthMax !== undefined && Number.isFinite(updates.azimuthMax)) bm.azimuthMax = updates.azimuthMax;
    if (updates.polarMin !== undefined && Number.isFinite(updates.polarMin)) bm.polarMin = updates.polarMin;
    if (updates.polarMax !== undefined && Number.isFinite(updates.polarMax)) bm.polarMax = updates.polarMax;
    if (updates.fov !== undefined && Number.isFinite(updates.fov)) bm.fov = updates.fov;
    if (updates.minDistance !== undefined && Number.isFinite(updates.minDistance)) {
      bm.minDistance = Math.max(0, updates.minDistance);
    }
    if (updates.clearMaxDistance) {
      delete bm.maxDistance;
    } else if (updates.maxDistance !== undefined && Number.isFinite(updates.maxDistance)) {
      bm.maxDistance = Math.max(bm.minDistance ?? 0, updates.maxDistance);
    }
    if (updates.focalDistance !== undefined && Number.isFinite(updates.focalDistance)) bm.focalDistance = updates.focalDistance;
    if (updates.apertureSize !== undefined && Number.isFinite(updates.apertureSize)) bm.apertureSize = updates.apertureSize;
    if (updates.cameraMode !== undefined) {
      if (updates.cameraMode === "orbit") {
        delete bm.cameraMode;
      } else {
        bm.cameraMode = "freelook";
      }
    }
    this.onManifestChange?.(this._manifest);
  }

  getCameraBookmark(id: string): NamedCameraBookmark | null {
    const list = this.getCameraBookmarks();
    return list.find((b) => b.id === id) ?? null;
  }

  addAnnotation(
    view: ViewMode,
    pos: [number, number, number],
    text: string,
    bookmarkId?: string
  ): void {
    const model = this._manifest.models.find((m) => m.id === this._state.modelId);
    if (!model) return;
    const id = `ann-${Date.now()}`;
    model.annotations.push({ id, view, pos, text, bookmarkId });
    this.onManifestChange?.(this._manifest);
  }

  updateAnnotation(id: string, updates: Partial<{ view: ViewMode; pos: [number, number, number]; text: string; bookmarkId?: string }>): void {
    const model = this._manifest.models.find((m) => m.id === this._state.modelId);
    if (!model) return;
    const ann = model.annotations.find((a) => a.id === id);
    if (!ann) return;
    Object.assign(ann, updates);
    this.onManifestChange?.(this._manifest);
  }

  removeAnnotation(id: string): void {
    const model = this._manifest.models.find((m) => m.id === this._state.modelId);
    if (!model) return;
    model.annotations = model.annotations.filter((a) => a.id !== id);
    this.onManifestChange?.(this._manifest);
  }

  setManifest(manifest: SceneManifest): void {
    this._manifest = manifest;
    this._state.modelId = manifest.defaults.modelId;
    this._state.activeLayer = { kind: "base" };
    this.onManifestChange?.(this._manifest);
  }

  /**
   * Restore manifest without triggering onManifestChange (e.g. for undo/redo).
   */
  restoreManifest(manifest: SceneManifest): void {
    this._manifest = manifest;
    this._state.modelId = manifest.defaults.modelId;
    this._state.activeLayer = { kind: "base" };
  }
}
