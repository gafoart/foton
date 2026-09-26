import "./style.css";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import {
  SceneRuntime,
  FreeLookController,
  clearOrbitControlsTransientState,
  createManagedSceneLights,
  applySceneBackground,
  applyManagedSceneLighting,
  applySceneFog,
  applyBlackdropTint,
  applyChangan3DTint,
  applyNameplateMatcapFromOptions,
  readChangan3DDefaultTintHex,
  applyFloorBrightness,
  applyCeilingBrightness,
} from "@changan/scene-runtime";
import {
  validateManifest,
  validateManifestSafe,
  getPivot,
  getPivotRot,
  getScale,
  ensureContactShadowDefaults,
  DEFAULT_CONTACT_SHADOW_TRANSFORM,
  resolveContactShadowGradient,
  resolveContactShadowCornerRadius,
} from "@changan/shared";
import { createContactShadowDiskGroup } from "@changan/scene-runtime/contactShadow";
import type {
  SceneManifest,
  ModelDef,
  AccessoryDef,
  AssetDef,
  TransformDef,
  NamedCameraBookmark,
  CameraInteractionMode,
  SplatLayerKind,
} from "@changan/shared";
import { EditorRuntime } from "./editor/EditorRuntime.js";
import type { ActiveLayerRef } from "./editor/EditorRuntime.js";
import { TransformGizmosController } from "./editor/TransformGizmos.js";
import type { GizmoMode } from "./editor/TransformGizmos.js";
import { createTransformParamsPanel } from "./editor/TransformParamsPanel.js";
import { createCameraBookmarksPanel } from "./editor/CameraBookmarksPanel.js";
import { createBookmarkNavigator } from "./editor/BookmarkNavigator.js";
import { createAssetsLayerPanel, type AssetLayerInfo } from "./editor/AssetsLayerPanel.js";
import { createColorRangePanel } from "./editor/ColorRangePanel.js";
import { CameraTravelAnimation } from "./editor/CameraTravel.js";
import { LayerFadeAnimation } from "./editor/LayerFade.js";
import { UndoRedoManager } from "./editor/UndoRedoManager.js";
import {
  MANIFEST_STORAGE_KEY,
  viewerApiBaseUrl,
  useRemoteManifestApi,
  manifestAuthFetchInit,
  manifestReadFetchInit,
  resolveSplatAssetUrl,
} from "@changan/shared";
import { ManifestDraft } from "./editor/ManifestDraft.js";
import { downloadManifest, validateForExport } from "./editor/ExportManifest.js";
import { createSceneAppearancePanel } from "./editor/SceneAppearancePanel.js";

const SPLATS_MANIFEST_URL = "/__splats-manifest";
const remoteManifestApi = useRemoteManifestApi();
const viewerApiOrigin = viewerApiBaseUrl();
const MANIFEST_LOAD_URL = remoteManifestApi
  ? `${viewerApiOrigin}/api/manifest`
  : "/__load-manifest";
const MANIFEST_DRAFT_POST_URL = remoteManifestApi
  ? `${viewerApiOrigin}/api/manifest-draft`
  : "/__manifest-draft";
const MANIFEST_SAVE_URL = remoteManifestApi
  ? `${viewerApiOrigin}/api/manifest`
  : "/__save-manifest";
const LOCAL_SAVE_URL = "/__save-manifest";

async function init(): Promise<void> {
  const app = document.getElementById("app")!;

  const layout = document.createElement("div");
  layout.className = "editor-layout";

  const canvasArea = document.createElement("div");
  canvasArea.className = "editor-canvas-area";
  canvasArea.tabIndex = 0;
  const canvas = document.createElement("canvas");
  canvasArea.appendChild(canvas);

  const rightPanel = document.createElement("div");
  rightPanel.className = "editor-right-panel";

  layout.appendChild(canvasArea);
  layout.appendChild(rightPanel);
  app.appendChild(layout);
  canvasArea.focus({ preventScroll: true });

  const keys = new Set<string>();
  const moveSpeed = 0.08;
  const _dir = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);

  let cameraTravel: CameraTravelAnimation;
  let selectedBookmarkIdRef: string | null = null;
  let isEditingBookmarkPivot = false;
  let onBookmarkPosUpdate: (() => void) | null = null;
  /** `edit`: bookmark selected but camera not committed (Go). `live`: after travel / Go. */
  let bookmarkViewportStage: "edit" | "live" = "edit";
  let onFreelookSync: (() => void) | null = null;
  /** Restores transform gizmo visibility after leaving free-look live. */
  let gizmoVisibleBeforeFreelookLive: boolean | null = null;
  const tickCtx: {
    editorRuntime: EditorRuntime | null;
    freeLook: FreeLookController | null;
  } = { editorRuntime: null, freeLook: null };

  const runtime = new SceneRuntime({
    canvas,
    container: canvasArea,
    onTick: () => {
      const camActive = cameraTravel?.update() ?? false;
      const fadeActive = layerFade?.update() ?? false;
      if (camActive || fadeActive) return;
      if (tickCtx.freeLook?.enabled) {
        return;
      }
      if (keys.size === 0) return;
      const camPos = runtime.camera.position;
      const target = runtime.controls.target;
      _dir.subVectors(target, camPos).setY(0);
      if (_dir.lengthSq() < 1e-6) {
        // Camera directly above/below target – fall back to world -Z forward
        _dir.set(0, 0, -1);
      } else {
        _dir.normalize();
      }
      _right.crossVectors(_dir, _up).normalize();

      if (keys.has("w")) {
        camPos.addScaledVector(_dir, moveSpeed);
        target.addScaledVector(_dir, moveSpeed);
      }
      if (keys.has("s")) {
        camPos.addScaledVector(_dir, -moveSpeed);
        target.addScaledVector(_dir, -moveSpeed);
      }
      if (keys.has("a")) {
        camPos.addScaledVector(_right, -moveSpeed);
        target.addScaledVector(_right, -moveSpeed);
      }
      if (keys.has("d")) {
        camPos.addScaledVector(_right, moveSpeed);
        target.addScaledVector(_right, moveSpeed);
      }
      if (keys.has("q")) {
        camPos.y -= moveSpeed;
        target.y -= moveSpeed;
      }
      if (keys.has("e")) {
        camPos.y += moveSpeed;
        target.y += moveSpeed;
      }
      if (selectedBookmarkIdRef) onBookmarkPosUpdate?.();
    },
    onAfterControlsUpdate: () => {
      const fl = tickCtx.freeLook;
      if (fl?.enabled) {
        fl.maintain();
      }
    },
    /** OrbitControls.update() moves the camera every frame; never run it while free-look owns the pose. */
    shouldSkipControlsUpdate: () => tickCtx.freeLook?.enabled === true,
  });

  const managedLights = createManagedSceneLights(runtime.scene);

  cameraTravel = new CameraTravelAnimation({
    camera: runtime.camera,
    controls: runtime.controls,
    duration: 900,
  });

  // Listen on the WebGL canvas only — not canvasArea — so capture-phase handlers
  // do not swallow clicks on sibling UI (bookmark navigator, color bar, etc.).
  const freeLook = new FreeLookController(
    runtime.camera as THREE.PerspectiveCamera,
    canvas,
    {
      onAfterLookChange: () => onFreelookSync?.(),
    }
  );
  tickCtx.freeLook = freeLook;

  let layerFade: LayerFadeAnimation;
  layerFade = new LayerFadeAnimation({ duration: 900 });

  const handleKeyDown = (e: KeyboardEvent): void => {
    const el = document.activeElement;
    if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.tagName === "SELECT") return;
    const k = e.key.toLowerCase();
    if (["w", "a", "s", "d", "q", "e"].includes(k)) {
      keys.add(k);
      e.preventDefault();
      e.stopPropagation();
    }
    // Gizmo shortcuts: 1=move, 2=rotate, 3=scale
    if (["1", "2", "3"].includes(k)) {
      const modeMap: Record<string, GizmoMode> = {
        "1": "translate",
        "2": "rotate",
        "3": "scale",
      };
      setGizmoMode(modeMap[k]);
      e.preventDefault();
    }
  };
  const handleKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.key.toLowerCase());
  };
  canvasArea.addEventListener("click", () => canvasArea.focus());
  window.addEventListener("keydown", handleKeyDown, { capture: true });
  window.addEventListener("keyup", handleKeyUp, { capture: true });

  // Load manifest: 1) saved file, 2) localStorage draft (user's work), 3) splats discovery, 4) empty
  // Prefer localStorage over splats when file fails – splats has no transforms/bookmarks and would reset everything
  let manifest: SceneManifest;
  const storedDraft = ManifestDraft.loadFromStorage();
  const emptyManifest = (): SceneManifest =>
    ({ version: 2, defaults: { modelId: "", view: "exterior" }, models: [] });

  let manifestSource = "empty";
  try {
    const savedRes = await fetch(
      MANIFEST_LOAD_URL,
      manifestReadFetchInit({ cache: "no-store" })
    );
    if (savedRes.ok) {
      const savedData = await savedRes.json();
      if (savedData?.models?.length > 0) {
        const parsed = validateManifestSafe(savedData);
        if (parsed.success) {
          manifest = parsed.data;
          manifestSource = "file";
        } else {
          console.warn("[editor] manifest.json validation failed:", parsed.error);
          throw new Error("Manifest validation failed");
        }
      } else {
        throw new Error("Empty saved manifest");
      }
    } else {
      throw new Error(`No saved manifest (status ${savedRes.status})`);
    }
  } catch (fileErr) {
    console.warn("[editor] File manifest load failed:", fileErr);
    if (storedDraft && storedDraft.models.length > 0) {
      manifest = storedDraft;
      manifestSource = "localStorage";
    } else {
      try {
        const splatsRes = await fetch(SPLATS_MANIFEST_URL, { cache: "no-store" });
        if (splatsRes.ok) {
          const splatsData = await splatsRes.json();
          if (splatsData?.models?.length > 0) {
            const parsed = validateManifestSafe(splatsData);
            manifest = parsed.success ? parsed.data : emptyManifest();
            manifestSource = parsed.success ? "splats" : "empty";
          } else {
            manifest = emptyManifest();
          }
        } else {
          manifest = emptyManifest();
        }
      } catch {
        manifest = emptyManifest();
      }
    }
  }
  const firstModel = manifest.models[0];
  const firstBookmarks = firstModel?.cameraBookmarks?.length ?? 0;
  const hasDealership = !!manifest.dealership;
  const hasBlackdrop = !!manifest.blackdrop;
  console.log(
    `[editor] Loaded manifest from ${manifestSource}: ` +
    `${manifest.models.length} models, ` +
    `first="${firstModel?.id}" with ${firstBookmarks} bookmarks, ` +
    `dealership=${hasDealership} blackdrop=${hasBlackdrop}`
  );

  ensureContactShadowDefaults(manifest);

  const manifestDraft = new ManifestDraft({
    initial: manifest,
    persistKey: MANIFEST_STORAGE_KEY,
    onChange: () => {},
  });
  // Sync to bridge so showroom on different port can fetch
  fetch(
    MANIFEST_DRAFT_POST_URL,
    manifestAuthFetchInit({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifestDraft.manifest),
    })
  ).catch(() => {});

  const applySceneStyleFromManifest = (): void => {
    const m = manifestDraft.manifest;
    applySceneBackground(runtime.renderer, runtime.scene, m.scene?.backgroundColor);
    applyManagedSceneLighting(managedLights, m.scene?.lighting);
    applySceneFog(runtime.scene, m.scene?.lighting?.fog);
  };
  applySceneStyleFromManifest();

  const undoRedo = new UndoRedoManager({ initial: manifest });
  const editorRuntime = new EditorRuntime({
    runtime,
    manifest: manifestDraft.manifest,
    onManifestChange: (m) => {
      undoRedo.recordChange(m);
      manifestDraft.setManifest(m);
      // Bridge for showroom on different port (e.g. 5173) to fetch from editor (5174)
      fetch(
        MANIFEST_DRAFT_POST_URL,
        manifestAuthFetchInit({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(m),
        })
      ).catch(() => {});
    },
  });
  tickCtx.editorRuntime = editorRuntime;

  const transformGizmos = new TransformGizmosController({
    camera: runtime.camera,
    domElement: canvas,
    orbitControls: runtime.controls,
  });
  transformGizmos.attachToScene(runtime.scene);

  // Pivot proxy for selected bookmark (translate-only gizmo at orbit center)
  const pivotProxy = new THREE.Group();
  const pivotSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 16, 12),
    new THREE.MeshBasicMaterial({
      color: 0x2a6aaa,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    })
  );
  pivotProxy.add(pivotSphere);
  pivotProxy.visible = false;
  runtime.scene.add(pivotProxy);

  let transformGroupRef: THREE.Group | null = null;
  let meshRef: { mesh: import("@sparkjsdev/spark").SplatMesh } | null = null;
  let editingNameplate3d = false;
  let editingContactShadow = false;

  /** Synthetic layer URL for the optional `{modelId}.glb` 3D nameplate in the left panel. */
  const NAMEPLATE3D_LAYER_URL = "__nameplate3d__";
  /** Synthetic row for manifest `contactShadow` (floor disk). */
  const CONTACT_SHADOW_LAYER_URL = "__contact_shadow__";

  // Asset refs keyed by URL (all loaded when model is selected)
  const assetRefs: Record<string, { group: THREE.Group; mesh: import("@sparkjsdev/spark").SplatMesh }> = {};

  /** ActiveLayerRef for a non-synthetic panel row. */
  function layerToRef(layer: AssetLayerInfo): ActiveLayerRef {
    return {
      kind: layer.kind,
      ...(layer.accessoryId !== undefined ? { accessoryId: layer.accessoryId } : {}),
    };
  }

  /** AssetDef backing a non-synthetic layer row, or undefined when the model lacks it. */
  function resolveLayerDef(model: ModelDef, layer: AssetLayerInfo): AssetDef | undefined {
    if (layer.isNameplate3d || layer.isContactShadow) return undefined;
    switch (layer.kind) {
      case "base":
        return model.base;
      case "motor":
        return model.motor;
      case "interior":
        return model.interior;
      case "accessory":
        return model.accessories.find((a) => a.id === layer.accessoryId)?.asset;
    }
  }

  function getAssetLayers(modelId: string): AssetLayerInfo[] {
    const model = manifestDraft.manifest.models.find((m) => m.id === modelId);
    if (!model) return [];
    const seen = new Set<string>();
    const out: AssetLayerInfo[] = [];
    const push = (
      def: AssetDef | undefined,
      kind: SplatLayerKind,
      label: string,
      accessoryId?: string
    ): void => {
      if (!def || seen.has(def.url)) return;
      seen.add(def.url);
      out.push({
        url: def.url,
        label,
        kind,
        ...(accessoryId !== undefined ? { accessoryId } : {}),
      });
    };
    push(model.base, "base", "Base");
    for (const acc of model.accessories) {
      push(acc.asset, "accessory", acc.name, acc.id);
    }
    push(model.motor, "motor", "Motor");
    push(model.interior, "interior", "Interior");
    out.push({
      url: NAMEPLATE3D_LAYER_URL,
      label: "Nombre 3D",
      kind: "base",
      isNameplate3d: true,
    });
    out.push({
      url: CONTACT_SHADOW_LAYER_URL,
      label: "Contact shadow",
      kind: "base",
      isContactShadow: true,
    });
    return out;
  }

  /**
   * Layer visibility for a bookmark. Accessories combine the bookmark's single
   * `accessory` flag with the layer's own panel eye toggle — the user's per-
   * accessory toggles decide WHICH accessory shows.
   */
  function bookmarkLayerTargetVisible(
    modelId: string,
    layer: AssetLayerInfo,
    bm: NamedCameraBookmark
  ): boolean {
    if (layer.isContactShadow || layer.isNameplate3d) {
      return bm.visibility.base;
    }
    switch (layer.kind) {
      case "base":
        return bm.visibility.base;
      case "motor":
        return bm.visibility.motor;
      case "interior":
        return bm.visibility.interior;
      case "accessory":
        return bm.visibility.accessory && assetsLayerPanel.getVisibility(modelId, layer);
    }
  }

  const nameplateGroup = new THREE.Group();
  nameplateGroup.userData.isNameplate3d = true;
  nameplateGroup.userData.modelId = "";
  let nameplateLoadedModelId = "";

  const contactShadowDisk = createContactShadowDiskGroup(0.9);
  const contactShadowGroup = contactShadowDisk.group;
  contactShadowGroup.userData.modelId = "";
  contactShadowGroup.userData.isContactShadow = true;
  runtime.getSplatContainer().add(contactShadowGroup);

  const DEFAULT_NAMEPLATE3D_TRANSFORM: TransformDef = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: 1 };
  function getNameplate3dTransformForModel(mid: string): TransformDef {
    const m = manifestDraft.manifest.models.find((x) => x.id === mid);
    return m?.nameplate3d?.transform ?? DEFAULT_NAMEPLATE3D_TRANSFORM;
  }
  function getNameplate3dTransform(): TransformDef {
    return getNameplate3dTransformForModel(editorRuntime.state.modelId);
  }
  function applyNameplate3dTransform(t: TransformDef): void {
    nameplateGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    nameplateGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    nameplateGroup.scale.set(sx, sy, sz);
  }

  function getContactShadowTransform(): TransformDef {
    const m = manifestDraft.manifest.models.find((x) => x.id === editorRuntime.state.modelId);
    return m?.contactShadow?.transform ?? { ...DEFAULT_CONTACT_SHADOW_TRANSFORM };
  }

  function disposeGlbSubtree(root: THREE.Object3D): void {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m?.dispose();
      }
    });
  }

  async function loadNameplate3dForModel(modelId: string): Promise<void> {
    if (!modelId) return;
    if (nameplateLoadedModelId === modelId && nameplateGroup.children.length > 0) return;
    const url = resolveSplatAssetUrl(`/splats/${modelId}/${modelId}.glb`);
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(url);
      if (editorRuntime.state.modelId !== modelId) {
        // User switched model while this GLB was loading — don't show the wrong nameplate.
        disposeGlbSubtree(gltf.scene);
        return;
      }
      while (nameplateGroup.children.length > 0) {
        const c = nameplateGroup.children[0]!;
        nameplateGroup.remove(c);
        disposeGlbSubtree(c);
      }
      nameplateGroup.add(gltf.scene);
      nameplateGroup.userData.modelId = modelId;
      nameplateLoadedModelId = modelId;
      nameplateGroup.visible = true;
      nameplateGroup.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.renderOrder = -50;
        }
      });
      applyNameplate3dTransform(getNameplate3dTransformForModel(modelId));
      void applyNameplateMatcapFromOptions(
        nameplateGroup,
        manifestDraft.manifest.scene?.nameplateMatcap
      );
      if (!nameplateGroup.parent) {
        runtime.getSplatContainer().add(nameplateGroup);
      }
    } catch {
      while (nameplateGroup.children.length > 0) {
        const c = nameplateGroup.children[0]!;
        nameplateGroup.remove(c);
        disposeGlbSubtree(c);
      }
      nameplateGroup.userData.modelId = "";
      nameplateLoadedModelId = "";
      nameplateGroup.visible = false;
    }
  }

  // Left panel - Layers (file-based)
  const assetsLayerPanel = createAssetsLayerPanel({
    models: manifest.models.map((m) => ({ id: m.id, name: m.name })),
    initialModelId: manifest.defaults.modelId,
    getAssetLayers,
    getActiveLayer: () => {
      const { modelId, activeLayer } = editorRuntime.state;
      const layers = getAssetLayers(modelId);
      if (editingContactShadow) {
        return layers.find((l) => l.isContactShadow) ?? null;
      }
      if (editingNameplate3d) {
        return layers.find((l) => l.isNameplate3d) ?? null;
      }
      return (
        layers.find(
          (l) =>
            !l.isNameplate3d &&
            !l.isContactShadow &&
            l.kind === activeLayer.kind &&
            (l.kind !== "accessory" || l.accessoryId === activeLayer.accessoryId)
        ) ??
        layers.find((l) => !l.isNameplate3d && !l.isContactShadow) ??
        null
      );
    },
    onSelect: (modelId, layer) => {
      if (editingDealership) {
        editingDealership = false;
        updateEditDealershipBtnLabel();
      }
      if (editingBlackdrop) {
        editingBlackdrop = false;
        updateEditBlackdropBtnLabel();
      }
      if (editingChangan3D) {
        editingChangan3D = false;
        updateEditChangan3dBtnLabel();
      }
      if (editingFloor) {
        editingFloor = false;
        updateEditFloorBtnLabel();
      }
      if (editingCeiling) {
        editingCeiling = false;
        updateEditCeilingBtnLabel();
      }
      if (editingPano) {
        editingPano = false;
        updateEditPanoBtnLabel();
      }
      if (layer.isContactShadow) {
        const modelChanged = editorRuntime.state.modelId !== modelId;
        if (modelChanged) {
          editingContactShadow = false;
          assetsLayerPanel.ensureGroupVisible(modelId);
          assetsLayerPanel.resetToBaseOnly(modelId);
          editorRuntime.setModel(modelId);
          loadAllAssets(layer);
          currentBookmarkIndex = 0;
          cameraBookmarksPanel.refresh();
          bookmarkNavigator.refresh();
        } else {
          editingContactShadow = true;
          editingNameplate3d = false;
          selectedBookmarkIdRef = null;
          isEditingBookmarkPivot = false;
          pivotProxy.visible = false;
          cameraBookmarksPanel.setSelectedBookmarkId(null);
          cameraBookmarksPanel.refresh();
          bookmarkNavigator.refresh();
          transformGroupRef = contactShadowGroup;
          meshRef = null;
          editorRuntime.setActiveMesh(null);
          const cs = manifestDraft.manifest.models.find((x) => x.id === modelId)?.contactShadow;
          const t = cs?.transform ?? { ...DEFAULT_CONTACT_SHADOW_TRANSFORM };
          transformGizmos.setTransform(t);
          applyContactShadowFromManifest(modelId);
          assetsLayerPanel.setActive(modelId, layer);
          applyGizmoTargetAndMode();
          syncLayerVisibilityFromPanel(modelId);
          transformParamsPanel.refresh();
          contactShadowOpacityInput.value = String(cs?.opacity ?? 0.9);
        }
        return;
      }
      if (layer.isNameplate3d) {
        const modelChanged = editorRuntime.state.modelId !== modelId;
        if (modelChanged) {
          assetsLayerPanel.ensureGroupVisible(modelId);
          assetsLayerPanel.resetToBaseOnly(modelId);
          editorRuntime.setModel(modelId);
          loadAllAssets(layer);
          currentBookmarkIndex = 0;
          cameraBookmarksPanel.refresh();
          bookmarkNavigator.refresh();
        } else {
          editingNameplate3d = true;
          editingContactShadow = false;
          selectedBookmarkIdRef = null;
          isEditingBookmarkPivot = false;
          pivotProxy.visible = false;
          cameraBookmarksPanel.setSelectedBookmarkId(null);
          cameraBookmarksPanel.refresh();
          bookmarkNavigator.refresh();
          transformGroupRef = nameplateGroup;
          meshRef = null;
          editorRuntime.setActiveMesh(null);
          const t = getNameplate3dTransform();
          transformGizmos.setTransform(t);
          applyNameplate3dTransform(t);
          assetsLayerPanel.setActive(modelId, layer);
          applyGizmoTargetAndMode();
          syncLayerVisibilityFromPanel(modelId);
          transformParamsPanel.refresh();
        }
        return;
      }
      editingNameplate3d = false;
      editingContactShadow = false;
      const modelChanged = editorRuntime.state.modelId !== modelId;
      if (modelChanged) {
        assetsLayerPanel.ensureGroupVisible(modelId);
        assetsLayerPanel.resetToBaseOnly(modelId, layer);
        editorRuntime.setModel(modelId);
        editorRuntime.setActiveLayer(layerToRef(layer));
        loadAllAssets(layer);
        currentBookmarkIndex = 0;
        cameraBookmarksPanel.refresh();
        bookmarkNavigator.refresh();
      } else {
        editorRuntime.setActiveLayer(layerToRef(layer));
        colorRangePanel.clearSelection();
        const ref = assetRefs[layer.url];
        if (ref) {
          transformGroupRef = ref.group;
          meshRef = { mesh: ref.mesh };
          transformGizmos.setTarget(ref.group);
          const model = manifestDraft.manifest.models.find((m) => m.id === modelId);
          const def = model ? resolveLayerDef(model, layer) : undefined;
          if (def) {
            transformGizmos.setTransform(def.transform);
            transformGizmos.applyPivotToMesh(ref.mesh, getPivot(def.transform), getPivotRot(def.transform));
          }
          transformParamsPanel.refresh();
        }
        assetsLayerPanel.setActive(modelId, layer);
        applyGizmoTargetAndMode();
        syncLayerVisibilityFromPanel(modelId);
      }
    },
    onVisibilityChange: (modelId, layer) => {
      if (editorRuntime.state.modelId !== modelId) return;
      syncLayerVisibilityFromPanel(modelId);
    },
  });

  function contactShadowLayerInfo(): AssetLayerInfo {
    return {
      url: CONTACT_SHADOW_LAYER_URL,
      label: "Contact shadow",
      kind: "base",
      isContactShadow: true,
    };
  }

  function applyContactShadowFromManifest(modelId: string): void {
    const cs = manifestDraft.manifest.models.find((x) => x.id === modelId)?.contactShadow;
    contactShadowGroup.userData.modelId = modelId;
    if (!cs) {
      contactShadowGroup.visible = false;
      return;
    }
    contactShadowDisk.material.opacity = cs.opacity ?? 0.9;
    contactShadowDisk.setCornerRadiusT(cs.cornerRadius);
    contactShadowDisk.applyResolvedGradient(resolveContactShadowGradient(cs.gradient));
    const t = cs.transform;
    contactShadowGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    contactShadowGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    contactShadowGroup.scale.set(sx, sy, sz);
    const vis = assetsLayerPanel.getVisibility(modelId, contactShadowLayerInfo());
    contactShadowGroup.visible = vis;
  }

  const deg2rad = (d: number) => (d * Math.PI) / 180;
  let dofEnabled = true;
  /**
   * `?backdrop=1` — skip the dealership environment entirely (dealership splat,
   * floor, ceiling, 360 pano background). Only blackdrop + nameplate + fog load.
   */
  const backdropOnly = (() => {
    const v = new URLSearchParams(window.location.search).get("backdrop");
    return v === "1" || v === "true";
  })();
  const DEALERSHIP_URL = resolveSplatAssetUrl("/splats/dealership.sog");
  const dealershipGroup = new THREE.Group();
  dealershipGroup.userData.isDealership = true;
  let dealershipVisible = !backdropOnly;
  /** Whether the dealership env (splat, floor, ceiling, pano) fetch was kicked off. */
  let dealershipEnvRequested = false;
  let editingDealership = false;
  const DEFAULT_DEALERSHIP_TRANSFORM: TransformDef = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: 1 };
  const getDealershipTransform = (): TransformDef =>
    manifestDraft.manifest.dealership?.transform ?? DEFAULT_DEALERSHIP_TRANSFORM;
  const applyDealershipTransform = (t: TransformDef): void => {
    dealershipGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    dealershipGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    dealershipGroup.scale.set(sx, sy, sz);
  };

  const DEFAULT_FLOOR_TRANSFORM: TransformDef = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: 1 };
  const getFloorTransform = (): TransformDef =>
    manifestDraft.manifest.floor?.transform ?? DEFAULT_FLOOR_TRANSFORM;
  const applyFloorTransform = (t: TransformDef): void => {
    floorGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    floorGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    floorGroup.scale.set(sx, sy, sz);
    applyFloorBrightness(floorGroup, manifestDraft.manifest.floor?.brightness);
  };

  const DEFAULT_CEILING_TRANSFORM: TransformDef = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: 1 };
  const getCeilingTransform = (): TransformDef =>
    manifestDraft.manifest.ceiling?.transform ?? DEFAULT_CEILING_TRANSFORM;
  const applyCeilingTransform = (t: TransformDef): void => {
    ceilingGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    ceilingGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    ceilingGroup.scale.set(sx, sy, sz);
    applyCeilingBrightness(ceilingGroup, manifestDraft.manifest.ceiling?.brightness);
  };

  const BLACKDROP_URL = resolveSplatAssetUrl("/splats/blackdrop.glb");
  const blackdropGroup = new THREE.Group();
  blackdropGroup.userData.isBlackdrop = true;
  let blackdropVisible = true;

  let editingBlackdrop = false;
  const DEFAULT_BLACKDROP_TRANSFORM: TransformDef = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: 1 };
  const getBlackdropTransform = (): TransformDef =>
    manifestDraft.manifest.blackdrop?.transform ?? DEFAULT_BLACKDROP_TRANSFORM;
  const applyBlackdropTransform = (t: TransformDef): void => {
    blackdropGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    blackdropGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    blackdropGroup.scale.set(sx, sy, sz);
  };

  const FLOOR_URL = resolveSplatAssetUrl("/splats/floor.glb");
  const floorGroup = new THREE.Group();
  floorGroup.userData.isFloor = true;
  let editingFloor = false;
  let updateEditFloorBtnLabel: () => void = () => {};

  const CEILING_URL = resolveSplatAssetUrl("/splats/ceiling.glb");
  const ceilingGroup = new THREE.Group();
  ceilingGroup.userData.isCeiling = true;
  let editingCeiling = false;
  let updateEditCeilingBtnLabel: () => void = () => {};

  const CHANGAN3D_URL = resolveSplatAssetUrl("/splats/foton3d.glb");
  const changan3dGroup = new THREE.Group();
  changan3dGroup.userData.isChangan3D = true;
  let editingChangan3D = false;
  /** Assigned when the edit button is created; safe for blackdrop toggle / bookmarks before that. */
  let updateEditChangan3dBtnLabel: () => void = () => {};
  const DEFAULT_CHANGAN3D_TRANSFORM: TransformDef = {
    pos: [0, 0.2, 1.4],
    rot: [0, 0, 0, 1],
    scale: 1,
  };
  const getChangan3DTransform = (): TransformDef =>
    manifestDraft.manifest.changan3D?.transform ?? DEFAULT_CHANGAN3D_TRANSFORM;
  const applyChangan3DTransform = (t: TransformDef): void => {
    changan3dGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    changan3dGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    changan3dGroup.scale.set(sx, sy, sz);
  };

  /** Equirect background sphere — wraps the dealership scene. */
  const panoGroup = new THREE.Group();
  panoGroup.userData.isPanoBackground = true;
  let editingPano = false;
  let updateEditPanoBtnLabel: () => void = () => {};
  let panoLoadedUrl = "";
  /** Default radius is set via group scale so the gizmo can shrink/grow it. */
  const DEFAULT_PANO_TRANSFORM: TransformDef = {
    pos: [0, 0, 0],
    rot: [0, 0, 0, 1],
    scale: [50, 50, 50],
  };
  const DEFAULT_PANO_URL = "/splats/pano_bg.jpg";
  /**
   * Last uniform scale value written for the pano. Tracked so the gizmo's
   * per-axis scale handles can be coerced into uniform: on each tick we pick
   * the axis whose value changed most vs this baseline and apply it to all 3.
   */
  let lastPanoUniformScale = 50;
  const getPanoTransform = (): TransformDef =>
    manifestDraft.manifest.panoBackground?.transform ?? DEFAULT_PANO_TRANSFORM;
  const applyPanoTransform = (t: TransformDef): void => {
    panoGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    panoGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    // Pano is constrained to uniform scale — collapse any non-uniform input
    // (manual manifest edit, gizmo per-axis handle) to a single value.
    const [sx, sy, sz] = getScale(t);
    const uniform = (sx + sy + sz) / 3;
    panoGroup.scale.set(uniform, uniform, uniform);
  };

  const reapplySceneAppearance = (): void => {
    applySceneStyleFromManifest();
    applyBlackdropTint(
      blackdropGroup,
      manifestDraft.manifest.blackdrop?.tint,
      manifestDraft.manifest.blackdrop?.tintStrength
    );
    applyChangan3DTint(changan3dGroup, manifestDraft.manifest.changan3D?.tint);
    const matcap = manifestDraft.manifest.scene?.nameplateMatcap;
    void applyNameplateMatcapFromOptions(changan3dGroup, matcap);
    void applyNameplateMatcapFromOptions(nameplateGroup, matcap);
    applyFloorBrightness(floorGroup, manifestDraft.manifest.floor?.brightness);
    applyCeilingBrightness(ceilingGroup, manifestDraft.manifest.ceiling?.brightness);
  };

  const applyBookmarkDoF = (bm: { focalDistance?: number; apertureSize?: number }) => {
    if (!dofEnabled) {
      runtime.spark.apertureAngle = 0;
      return;
    }
    const fd = bm.focalDistance ?? 5;
    const ap = bm.apertureSize ?? 0.1;
    runtime.spark.focalDistance = fd;
    runtime.spark.apertureAngle = fd > 0 ? 2 * Math.atan(0.5 * ap / fd) : 0;
  };
  type BookmarkOrbitAndLens = Pick<
    NamedCameraBookmark,
    "azimuthMin" | "azimuthMax" | "polarMin" | "polarMax" | "fov" | "minDistance" | "maxDistance"
  >;
  const applyBookmarkOrbitAngles = (bm: BookmarkOrbitAndLens): void => {
    const azMin = bm.azimuthMin ?? -180;
    const azMax = bm.azimuthMax ?? 180;
    const polMin = bm.polarMin ?? 5;
    const polMax = bm.polarMax ?? 175;
    runtime.controls.minAzimuthAngle = deg2rad(azMin);
    runtime.controls.maxAzimuthAngle = deg2rad(azMax);
    runtime.controls.minPolarAngle = deg2rad(polMin);
    runtime.controls.maxPolarAngle = deg2rad(polMax);
  };
  const applyBookmarkFov = (bm: BookmarkOrbitAndLens): void => {
    const cam = runtime.camera as THREE.PerspectiveCamera;
    const fov = bm.fov ?? 60;
    cam.fov = THREE.MathUtils.clamp(Number.isFinite(fov) ? fov : 60, 10, 150);
    cam.updateProjectionMatrix();
  };
  const applyBookmarkOrbitZoom = (bm: BookmarkOrbitAndLens): void => {
    const minD = bm.minDistance ?? 0;
    runtime.controls.minDistance = Math.max(0, minD);
    runtime.controls.maxDistance =
      bm.maxDistance !== undefined && Number.isFinite(bm.maxDistance)
        ? Math.max(runtime.controls.minDistance, bm.maxDistance)
        : Infinity;
  };
  const applyBookmarkConstraints = (bm: BookmarkOrbitAndLens): void => {
    applyBookmarkOrbitAngles(bm);
    applyBookmarkFov(bm);
    applyBookmarkOrbitZoom(bm);
    runtime.controls.update();
  };

  function resetOrbitControlsWide(): void {
    runtime.controls.minAzimuthAngle = -Infinity;
    runtime.controls.maxAzimuthAngle = Infinity;
    runtime.controls.minPolarAngle = 0;
    runtime.controls.maxPolarAngle = Math.PI;
    runtime.controls.minDistance = 0;
    runtime.controls.maxDistance = Infinity;
    runtime.controls.enableRotate = true;
    runtime.controls.enablePan = true;
    runtime.controls.enableZoom = true;
  }

  function applyCameraViewport(
    bm: NamedCameraBookmark | null,
    stage: "edit" | "live"
  ): void {
    const enteringFreelookLive = !!(
      bm &&
      stage === "live" &&
      bm.cameraMode === "freelook"
    );
    const wasFreelook = freeLook.enabled;

    if (wasFreelook && !enteringFreelookLive) {
      if (gizmoVisibleBeforeFreelookLive !== null) {
        transformGizmos.setVisible(gizmoVisibleBeforeFreelookLive);
        gizmoVisibleBeforeFreelookLive = null;
      }
      if (selectedBookmarkIdRef && isEditingBookmarkPivot) {
        pivotProxy.visible = true;
        transformGizmos.setTarget(pivotProxy);
        transformGizmos.setMode("translate");
      }
    }

    freeLook.enabled = false;
    transformGizmos.setPickingSuppressed(false);
    if (!bm) {
      resetOrbitControlsWide();
      runtime.controls.enabled = true;
      runtime.controls.update();
      return;
    }
    applyBookmarkDoF(bm);
    const wantsFreelook = bm.cameraMode === "freelook";

    if (stage !== "live" || !wantsFreelook) {
      resetOrbitControlsWide();
      applyBookmarkConstraints(bm);
      runtime.controls.enabled = true;
      return;
    }

    applyBookmarkFov(bm);
    if (gizmoVisibleBeforeFreelookLive === null) {
      gizmoVisibleBeforeFreelookLive = transformGizmos.getVisible();
    }
    transformGizmos.setVisible(false);
    pivotProxy.visible = false;
    freeLook.clearBookmarkAngleLimits();
    freeLook.setFromBookmark(bm.pos, bm.target);
    runtime.controls.enabled = false;
    runtime.controls.enableRotate = false;
    runtime.controls.enablePan = false;
    runtime.controls.enableZoom = false;
    clearOrbitControlsTransientState(runtime.controls);
    transformGizmos.setPickingSuppressed(true);
    freeLook.enabled = true;
  }

  function startBookmarkCameraTravel(bm: NamedCameraBookmark): void {
    freeLook.enabled = false;
    runtime.controls.enabled = false;
    if (bm.cameraMode === "freelook") {
      if (gizmoVisibleBeforeFreelookLive === null) {
        gizmoVisibleBeforeFreelookLive = transformGizmos.getVisible();
      }
      transformGizmos.setVisible(false);
      pivotProxy.visible = false;
      runtime.controls.enableRotate = false;
      runtime.controls.enablePan = false;
      runtime.controls.enableZoom = false;
    }
    transformGizmos.setPickingSuppressed(bm.cameraMode === "freelook");
    cameraTravel.start({
      pos: bm.pos,
      target: bm.target,
      onComplete: () => {
        bookmarkViewportStage = "live";
        applyCameraViewport(bm, "live");
      },
    });
  }

  let pendingCameraModeForNew: CameraInteractionMode = "orbit";

  // Camera bookmarks panel (bottom of left panel)
  let currentBookmarkIndex = 0;
  const cameraBookmarksPanel = createCameraBookmarksPanel({
    getModelName: () => {
      const m = manifestDraft.manifest.models.find((x) => x.id === editorRuntime.state.modelId);
      return m?.name ?? "";
    },
    getBookmarks: () => editorRuntime.getCameraBookmarks(),
    getCurrentCamera: () => {
      if (
        freeLook.enabled &&
        bookmarkViewportStage === "live" &&
        selectedBookmarkIdRef &&
        editorRuntime.getCameraBookmark(selectedBookmarkIdRef)?.cameraMode === "freelook"
      ) {
        const p = freeLook.lockedPosition;
        const t = freeLook.getLookTarget(2);
        return {
          pos: [p.x, p.y, p.z] as [number, number, number],
          target: [t.x, t.y, t.z] as [number, number, number],
        };
      }
      return {
        pos: [runtime.camera.position.x, runtime.camera.position.y, runtime.camera.position.z],
        target: [runtime.controls.target.x, runtime.controls.target.y, runtime.controls.target.z],
      };
    },
    getCurrentConstraints: () => {
      const fin = (v: number, fallback: number) => Number.isFinite(v) ? v : fallback;
      return {
        azimuthMin: fin((runtime.controls.minAzimuthAngle * 180) / Math.PI, -180),
        azimuthMax: fin((runtime.controls.maxAzimuthAngle * 180) / Math.PI, 180),
        polarMin: fin((runtime.controls.minPolarAngle * 180) / Math.PI, 5),
        polarMax: fin((runtime.controls.maxPolarAngle * 180) / Math.PI, 175),
      };
    },
    getCurrentDoF: () => {
      const fd = Number.isFinite(runtime.spark.focalDistance) ? runtime.spark.focalDistance : 5;
      const aa = Number.isFinite(runtime.spark.apertureAngle) ? runtime.spark.apertureAngle : 0;
      const ap = fd > 0 && Number.isFinite(aa) ? 2 * fd * Math.tan(aa / 2) : 0.1;
      return { focalDistance: fd, apertureSize: Number.isFinite(ap) ? ap : 0.1 };
    },
    getCurrentLens: () => {
      const cam = runtime.camera as THREE.PerspectiveCamera;
      const max = runtime.controls.maxDistance;
      return {
        fov: cam.fov,
        minDistance: runtime.controls.minDistance,
        ...(Number.isFinite(max) ? { maxDistance: max } : {}),
      };
    },
    getVisibility: (k) => assetsLayerPanel.getVisibilityByKind(editorRuntime.state.modelId, k),
    onAdd: (name, pos, target, visibility, constraints, dof, lens) => {
      editorRuntime.addCameraBookmark(
        name,
        pos,
        target,
        visibility,
        constraints,
        dof,
        lens,
        pendingCameraModeForNew === "freelook" ? "freelook" : undefined
      );
      currentBookmarkIndex = editorRuntime.getCameraBookmarks().length - 1;
      bookmarkNavigator.refresh();
    },
    onRemove: (id) => {
      editorRuntime.removeCameraBookmark(id);
      const list = editorRuntime.getCameraBookmarks();
      currentBookmarkIndex = Math.min(currentBookmarkIndex, Math.max(0, list.length - 1));
      bookmarkNavigator.refresh();
    },
    onUpdate: (id, updates) => {
      editorRuntime.updateCameraBookmark(id, updates);
      const next = editorRuntime.getCameraBookmark(id);
      if (next && (updates.pos !== undefined || updates.target !== undefined)) {
        applyCameraViewport(next, bookmarkViewportStage);
      }
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    },
    onReorder: (id, direction) => {
      const list = editorRuntime.getCameraBookmarks();
      const i = list.findIndex((b) => b.id === id);
      if (i < 0) return;
      const j = i + direction;
      if (j < 0 || j >= list.length) return;
      if (currentBookmarkIndex === i) currentBookmarkIndex = j;
      else if (currentBookmarkIndex === j) currentBookmarkIndex = i;
      editorRuntime.moveCameraBookmark(id, direction);
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    },
    onSelectionChange: (id) => {
      if (id) {
        editingNameplate3d = false;
        editingContactShadow = false;
      }
      if (editingDealership && id) {
        editingDealership = false;
        updateEditDealershipBtnLabel();
      }
      if (editingBlackdrop && id) {
        editingBlackdrop = false;
        updateEditBlackdropBtnLabel();
      }
      if (editingChangan3D && id) {
        editingChangan3D = false;
        updateEditChangan3dBtnLabel();
      }
      if (editingFloor && id) {
        editingFloor = false;
        updateEditFloorBtnLabel();
      }
      if (editingCeiling && id) {
        editingCeiling = false;
        updateEditCeilingBtnLabel();
      }
      if (editingPano && id) {
        editingPano = false;
        updateEditPanoBtnLabel();
      }
      selectedBookmarkIdRef = id;
      bookmarkViewportStage = "edit";
      if (id) {
        const bm = editorRuntime.getCameraBookmark(id);
        if (bm) {
          pivotProxy.position.set(bm.target[0], bm.target[1], bm.target[2]);
          pivotProxy.visible = true;
          transformGizmos.setTarget(pivotProxy);
          transformGizmos.setMode("translate");
          isEditingBookmarkPivot = true;
          applyCameraViewport(bm, "edit");
        }
        refreshConstraintsUI?.();
        refreshDoFUI?.();
      } else {
        pivotProxy.visible = false;
        isEditingBookmarkPivot = false;
        applyGizmoTargetAndMode();
        applyCameraViewport(null, "edit");
        refreshConstraintsUI?.();
        refreshDoFUI?.();
      }
    },
    onApply: (bm) => {
      currentBookmarkIndex = editorRuntime.getCameraBookmarks().findIndex((b) => b.id === bm.id);
      if (currentBookmarkIndex < 0) currentBookmarkIndex = 0;
      bookmarkViewportStage = "edit";
      applyCameraViewport(bm, "edit");
      const modelId = editorRuntime.state.modelId;
      const fadeLayers = getAssetLayers(modelId)
        .map((layer) => {
          const ref = assetRefs[layer.url];
          if (!ref) return null;
          const fromVisible = ref.group.visible;
          const toVisible = bookmarkLayerTargetVisible(modelId, layer, bm);
          return { group: ref.group, fromVisible, toVisible };
        })
        .filter(Boolean) as Array<{ group: THREE.Group; fromVisible: boolean; toVisible: boolean }>;
      layerFade.start(fadeLayers, () => {
        for (const layer of getAssetLayers(modelId)) {
          const toVisible = bookmarkLayerTargetVisible(modelId, layer, bm);
          const persist =
            !layer.isNameplate3d && !layer.isContactShadow && layer.kind !== "accessory";
          assetsLayerPanel.setVisibility(modelId, layer, toVisible, persist);
        }
        applyBookmarkLayerMask(modelId, bm);
      });
      startBookmarkCameraTravel(bm);
      bookmarkNavigator.refresh();
    },
  });

  onBookmarkPosUpdate = () => {
    if (!selectedBookmarkIdRef) return;
    const bm = editorRuntime.getCameraBookmark(selectedBookmarkIdRef);
    if (
      bm?.cameraMode === "freelook" &&
      bookmarkViewportStage === "live" &&
      freeLook.enabled
    ) {
      const t = freeLook.getLookTarget(2);
      editorRuntime.updateCameraBookmark(selectedBookmarkIdRef, {
        pos: [bm.pos[0], bm.pos[1], bm.pos[2]],
        target: [t.x, t.y, t.z],
      });
    } else {
      const cam = runtime.camera.position;
      const tgt = runtime.controls.target;
      editorRuntime.updateCameraBookmark(selectedBookmarkIdRef, {
        pos: [cam.x, cam.y, cam.z],
        target: [tgt.x, tgt.y, tgt.z],
      });
    }
    cameraBookmarksPanel.refresh();
    bookmarkNavigator.refresh();
    const b2 = editorRuntime.getCameraBookmark(selectedBookmarkIdRef);
    if (b2) {
      pivotProxy.position.set(b2.target[0], b2.target[1], b2.target[2]);
    }
  };

  onFreelookSync = () => {
    if (!selectedBookmarkIdRef) return;
    const bm = editorRuntime.getCameraBookmark(selectedBookmarkIdRef);
    if (
      bm?.cameraMode !== "freelook" ||
      bookmarkViewportStage !== "live" ||
      !freeLook.enabled
    ) {
      return;
    }
    const t = freeLook.getLookTarget(2);
    editorRuntime.updateCameraBookmark(selectedBookmarkIdRef, {
      pos: [bm.pos[0], bm.pos[1], bm.pos[2]],
      target: [t.x, t.y, t.z],
    });
    cameraBookmarksPanel.refresh();
    bookmarkNavigator.refresh();
    pivotProxy.position.set(t.x, t.y, t.z);
  };

  /** Editor: splat visibility follows the Layers panel for every asset (multiple paint colors can be on for alignment). */
  function syncLayerVisibilityFromPanel(modelId: string): void {
    const layers = getAssetLayers(modelId);
    for (const layer of layers) {
      const visible = assetsLayerPanel.getVisibility(modelId, layer);
      if (layer.isNameplate3d) {
        nameplateGroup.visible = visible && nameplateGroup.children.length > 0;
        continue;
      }
      if (layer.isContactShadow) {
        continue;
      }
      const ref = assetRefs[layer.url];
      if (ref) {
        ref.group.visible = visible;
        // A bookmark layer fade may have left mesh.opacity at 0 — restore it,
        // otherwise a re-shown group still renders nothing.
        ref.mesh.opacity = visible ? 1 : 0;
      }
    }
    applyContactShadowFromManifest(modelId);
  }

  /**
   * After applying a bookmark: base/motor/interior follow the (persisted) panel
   * visibility; accessories additionally require the bookmark's `accessory` flag.
   */
  function applyBookmarkLayerMask(modelId: string, bm: NamedCameraBookmark): void {
    const layers = getAssetLayers(modelId);
    for (const layer of layers) {
      const visible =
        layer.kind === "accessory" && !layer.isNameplate3d && !layer.isContactShadow
          ? bookmarkLayerTargetVisible(modelId, layer, bm)
          : assetsLayerPanel.getVisibility(modelId, layer);
      if (layer.isNameplate3d) {
        nameplateGroup.visible = visible && nameplateGroup.children.length > 0;
      } else {
        const ref = assetRefs[layer.url];
        if (ref) {
          ref.group.visible = visible;
          ref.mesh.opacity = visible ? 1 : 0;
        }
      }
      assetsLayerPanel.setVisibility(modelId, layer, visible, false);
    }
    applyContactShadowFromManifest(modelId);
  }

  // Bookmark navigator (bottom center overlay)
  const bookmarkNavigator = createBookmarkNavigator({
    getBookmarks: () => editorRuntime.getCameraBookmarks(),
    getCurrentIndex: () => currentBookmarkIndex,
    onNavigate: (idx) => {
      const list = editorRuntime.getCameraBookmarks();
      const bm = list[idx];
      if (bm) {
        currentBookmarkIndex = idx;
        cameraBookmarksPanel.setSelectedBookmarkId(bm.id);
        bookmarkViewportStage = "edit";
        applyCameraViewport(bm, "edit");
        const modelId = editorRuntime.state.modelId;
        const fadeLayers = getAssetLayers(modelId)
          .map((layer) => {
            const ref = assetRefs[layer.url];
            if (!ref) return null;
            const fromVisible = ref.group.visible;
            const toVisible = bookmarkLayerTargetVisible(modelId, layer, bm);
            return { group: ref.group, fromVisible, toVisible };
          })
          .filter(Boolean) as Array<{ group: THREE.Group; fromVisible: boolean; toVisible: boolean }>;
        layerFade.start(fadeLayers, () => {
          for (const layer of getAssetLayers(modelId)) {
            const toVisible = bookmarkLayerTargetVisible(modelId, layer, bm);
            const persist =
              !layer.isNameplate3d && !layer.isContactShadow && layer.kind !== "accessory";
            assetsLayerPanel.setVisibility(modelId, layer, toVisible, persist);
          }
          applyBookmarkLayerMask(modelId, bm);
        });
        startBookmarkCameraTravel(bm);
        bookmarkNavigator.refresh();
      }
    },
  });

  // Double-click on canvas: set selected bookmark's pivot to the clicked 3D point
  const _raycaster = new THREE.Raycaster();
  const _mouse = new THREE.Vector2();
  const _plane = new THREE.Plane();
  const _planeNormal = new THREE.Vector3(0, 1, 0);
  const _intersect = new THREE.Vector3();
  canvas.addEventListener("dblclick", (e: MouseEvent) => {
    const selectedId = cameraBookmarksPanel.getSelectedBookmarkId();
    if (!selectedId) return;
    const rect = canvas.getBoundingClientRect();
    _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    _raycaster.setFromCamera(_mouse, runtime.camera);

    // Raycast against visible meshes
    const modelId = editorRuntime.state.modelId;
    const layers = getAssetLayers(modelId);
    const meshes: THREE.Object3D[] = [];
    for (const layer of layers) {
      const ref = assetRefs[layer.url];
      if (ref && assetsLayerPanel.getVisibility(modelId, layer)) {
        meshes.push(ref.mesh);
      }
    }

    let point: THREE.Vector3 | null = null;
    if (meshes.length > 0) {
      const hits = _raycaster.intersectObjects(meshes, true);
      if (hits.length > 0) point = hits[0].point;
    }
    // Fallback: horizontal plane through orbit target or free-look eye
    const planePt =
      freeLook.enabled &&
      bookmarkViewportStage === "live" &&
      editorRuntime.getCameraBookmark(selectedId)?.cameraMode === "freelook"
        ? freeLook.lockedPosition
        : runtime.controls.target;
    _plane.setFromNormalAndCoplanarPoint(_planeNormal, planePt);
    if (!point && _raycaster.ray.intersectPlane(_plane, _intersect)) {
      point = _intersect.clone();
    }
    if (point) {
      editorRuntime.updateCameraBookmark(selectedId, {
        target: [point.x, point.y, point.z],
      });
      const bm = editorRuntime.getCameraBookmark(selectedId);
      if (
        bm?.cameraMode === "freelook" &&
        bookmarkViewportStage === "live" &&
        freeLook.enabled
      ) {
        freeLook.setFromBookmark(bm.pos, [point.x, point.y, point.z]);
      } else {
        runtime.controls.target.set(point.x, point.y, point.z);
      }
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    }
  });
  canvasArea.title =
    "Click to focus for WASD (move) and Q/E (up/down) when using Orbit. Interior free look: drag to look from a fixed seat. Select a bookmark, click Go, then double-click to aim at a point.";

  layout.insertBefore(assetsLayerPanel.el, canvasArea);
  assetsLayerPanel.el.appendChild(cameraBookmarksPanel.el);
  const bottomOverlay = document.createElement("div");
  bottomOverlay.className = "editor-bottom-overlay";
  bottomOverlay.appendChild(bookmarkNavigator.el);
  canvasArea.appendChild(bottomOverlay);

  // Gizmo mode
  let currentGizmoMode: GizmoMode = "translate";

  const modeLabel = document.createElement("div");
  modeLabel.innerHTML = `
    <span>Gizmo:</span>
    <label><input type="radio" name="gizmo" value="translate" checked> Move</label>
    <label><input type="radio" name="gizmo" value="rotate"> Rotate</label>
    <label><input type="radio" name="gizmo" value="scale"> Scale</label>
    <label><input type="radio" name="gizmo" value="pivotTranslate"> Pivot Move</label>
    <label><input type="radio" name="gizmo" value="pivotRotate"> Pivot Rotate</label>
  `;
  function applyGizmoTargetAndMode(): void {
    if (editingChangan3D) {
      transformGizmos.setTarget(changan3dGroup);
      const mode =
        currentGizmoMode === "pivotTranslate" || currentGizmoMode === "pivotRotate"
          ? "translate"
          : currentGizmoMode;
      transformGizmos.setMode(mode);
      return;
    }
    if (editingFloor) {
      transformGizmos.setTarget(floorGroup);
      const mode =
        currentGizmoMode === "pivotTranslate" || currentGizmoMode === "pivotRotate"
          ? "translate"
          : currentGizmoMode;
      transformGizmos.setMode(mode);
      return;
    }
    if (editingCeiling) {
      transformGizmos.setTarget(ceilingGroup);
      const mode =
        currentGizmoMode === "pivotTranslate" || currentGizmoMode === "pivotRotate"
          ? "translate"
          : currentGizmoMode;
      transformGizmos.setMode(mode);
      return;
    }
    if (editingBlackdrop) {
      transformGizmos.setTarget(blackdropGroup);
      const mode =
        currentGizmoMode === "pivotTranslate" || currentGizmoMode === "pivotRotate"
          ? "translate"
          : currentGizmoMode;
      transformGizmos.setMode(mode);
      return;
    }
    if (editingDealership) {
      transformGizmos.setTarget(dealershipGroup);
      const mode = currentGizmoMode === "pivotTranslate" || currentGizmoMode === "pivotRotate" ? "translate" : currentGizmoMode;
      transformGizmos.setMode(mode);
      return;
    }
    if (editingPano) {
      transformGizmos.setTarget(panoGroup);
      const mode =
        currentGizmoMode === "pivotTranslate" || currentGizmoMode === "pivotRotate"
          ? "translate"
          : currentGizmoMode;
      transformGizmos.setMode(mode);
      return;
    }
    if (editingContactShadow) {
      transformGizmos.setTarget(contactShadowGroup);
      const mode =
        currentGizmoMode === "pivotTranslate" || currentGizmoMode === "pivotRotate"
          ? "translate"
          : currentGizmoMode;
      transformGizmos.setMode(mode);
      return;
    }
    if (editingNameplate3d) {
      transformGizmos.setTarget(nameplateGroup);
      const mode =
        currentGizmoMode === "pivotTranslate" || currentGizmoMode === "pivotRotate"
          ? "translate"
          : currentGizmoMode;
      transformGizmos.setMode(mode);
      return;
    }
    if (selectedBookmarkIdRef) {
      transformGizmos.setTarget(pivotProxy);
      transformGizmos.setMode("translate");
      return;
    }
    const mode = currentGizmoMode;
    const isPivot = mode === "pivotTranslate" || mode === "pivotRotate";
    if (isPivot && meshRef) {
      transformGizmos.setTarget(meshRef.mesh);
    } else if (transformGroupRef) {
      transformGizmos.setTarget(transformGroupRef);
    } else {
      transformGizmos.setTarget(null);
    }
    transformGizmos.setMode(mode);
  }
  function setGizmoMode(mode: GizmoMode): void {
    currentGizmoMode = mode;
    const radio = modeLabel.querySelector(`input[name="gizmo"][value="${mode}"]`) as HTMLInputElement | null;
    if (radio) radio.checked = true;
    applyGizmoTargetAndMode();
  }
  modeLabel.querySelectorAll('input[name="gizmo"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      currentGizmoMode = (e.target as HTMLInputElement).value as GizmoMode;
      applyGizmoTargetAndMode();
    });
  });

  const hideGizmoBtn = document.createElement("button");
  hideGizmoBtn.textContent = "Hide Gizmo";
  hideGizmoBtn.title = "Toggle gizmo visibility";
  hideGizmoBtn.addEventListener("click", () => {
    const visible = !transformGizmos.getVisible();
    transformGizmos.setVisible(visible);
    hideGizmoBtn.textContent = visible ? "Hide Gizmo" : "Show Gizmo";
  });
  modeLabel.appendChild(hideGizmoBtn);

  rightPanel.appendChild(modeLabel);

  // Camera orbit constraints (per-bookmark, X = azimuth, Y = polar)
  let refreshConstraintsUI: () => void = () => {};
  let refreshDoFUI: () => void = () => {};

  const cameraConstraintsSection = document.createElement("div");
  cameraConstraintsSection.className = "camera-constraints-section";
  const constraintsTitle = document.createElement("h4");
  constraintsTitle.textContent = "Camera constraints";
  cameraConstraintsSection.appendChild(constraintsTitle);
  const constraintsHint = document.createElement("div");
  constraintsHint.className = "camera-constraints-hint";
  constraintsHint.textContent = "Select a bookmark to edit its constraints";
  cameraConstraintsSection.appendChild(constraintsHint);
  const constraintsRows = document.createElement("div");
  constraintsRows.className = "camera-constraints-rows";

  const modeRow = document.createElement("div");
  modeRow.className = "camera-constraints-row camera-constraints-mode-row";
  const modeLabelSpan = document.createElement("span");
  modeLabelSpan.className = "camera-constraints-label";
  modeLabelSpan.textContent = "Control:";
  const modeOrbitLbl = document.createElement("label");
  modeOrbitLbl.className = "camera-constraints-mode-label";
  const modeOrbit = document.createElement("input");
  modeOrbit.type = "radio";
  modeOrbit.name = "editor-camera-mode";
  modeOrbit.value = "orbit";
  modeOrbit.title = "Orbit, zoom, and pan around the target";
  modeOrbitLbl.append(modeOrbit, document.createTextNode(" Orbit"));
  const modeFreeLbl = document.createElement("label");
  modeFreeLbl.className = "camera-constraints-mode-label";
  const modeFree = document.createElement("input");
  modeFree.type = "radio";
  modeFree.name = "editor-camera-mode";
  modeFree.value = "freelook";
  modeFree.title = "Fixed seat position; drag to look around (interiors)";
  modeFreeLbl.append(modeFree, document.createTextNode(" Interior free look"));
  modeRow.append(modeLabelSpan, modeOrbitLbl, modeFreeLbl);

  function syncCameraModeRadios(): void {
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    if (!id) {
      if (pendingCameraModeForNew === "freelook") modeFree.checked = true;
      else modeOrbit.checked = true;
      return;
    }
    const bm = editorRuntime.getCameraBookmark(id);
    if (bm?.cameraMode === "freelook") modeFree.checked = true;
    else modeOrbit.checked = true;
  }

  function onCameraModeRadioChange(): void {
    const mode: CameraInteractionMode = modeFree.checked ? "freelook" : "orbit";
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    if (!id) {
      pendingCameraModeForNew = mode;
      return;
    }
    editorRuntime.updateCameraBookmark(id, { cameraMode: mode });
    const bm = editorRuntime.getCameraBookmark(id);
    if (bm) applyCameraViewport(bm, bookmarkViewportStage);
    cameraBookmarksPanel.refresh();
    bookmarkNavigator.refresh();
  }
  modeOrbit.addEventListener("change", onCameraModeRadioChange);
  modeFree.addEventListener("change", onCameraModeRadioChange);

  const createConstraintRow = (label: string) => {
    const row = document.createElement("div");
    row.className = "camera-constraints-row";
    const labelSpan = document.createElement("span");
    labelSpan.className = "camera-constraints-label";
    labelSpan.textContent = label;
    const minInp = document.createElement("input");
    minInp.type = "number";
    minInp.step = "any";
    minInp.placeholder = "Min °";
    minInp.className = "camera-constraints-input";
    const maxInp = document.createElement("input");
    maxInp.type = "number";
    maxInp.step = "any";
    maxInp.placeholder = "Max °";
    maxInp.className = "camera-constraints-input";
    row.appendChild(labelSpan);
    row.appendChild(minInp);
    row.appendChild(maxInp);
    return { row, minInp, maxInp };
  };
  const xRow = createConstraintRow("X (azimuth):");
  const yRow = createConstraintRow("Y (polar):");
  const fovRowEl = document.createElement("div");
  fovRowEl.className = "camera-constraints-row";
  const fovLabelSpan = document.createElement("span");
  fovLabelSpan.className = "camera-constraints-label";
  fovLabelSpan.textContent = "FoV (°):";
  const fovInp = document.createElement("input");
  fovInp.type = "number";
  fovInp.step = "1";
  fovInp.min = "10";
  fovInp.max = "150";
  fovInp.title = "Vertical field of view (degrees)";
  fovInp.className = "camera-constraints-input";
  fovInp.style.flex = "2";
  fovRowEl.appendChild(fovLabelSpan);
  fovRowEl.appendChild(fovInp);
  const zoomDistRow = createConstraintRow("Zoom (dist.):");
  zoomDistRow.minInp.placeholder = "Min";
  zoomDistRow.maxInp.placeholder = "Max (∞ if empty)";
  zoomDistRow.minInp.title = "Minimum camera distance from orbit target";
  zoomDistRow.maxInp.title = "Maximum distance; leave empty for no limit";
  constraintsRows.appendChild(modeRow);
  constraintsRows.appendChild(xRow.row);
  constraintsRows.appendChild(yRow.row);
  constraintsRows.appendChild(fovRowEl);
  constraintsRows.appendChild(zoomDistRow.row);
  cameraConstraintsSection.appendChild(constraintsRows);

  const resetConstraintsBtn = document.createElement("button");
  resetConstraintsBtn.type = "button";
  resetConstraintsBtn.className = "camera-constraints-reset-btn";
  resetConstraintsBtn.textContent = "Reset to default";
  resetConstraintsBtn.title =
    "Reset orbit (X/Y), field of view (60°), and zoom limits (min 0, max unlimited)";
  resetConstraintsBtn.addEventListener("click", () => {
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    if (!id) return;
    editorRuntime.updateCameraBookmark(id, {
      azimuthMin: -180,
      azimuthMax: 180,
      polarMin: 5,
      polarMax: 175,
      clearLens: true,
    });
    const updatedBm = editorRuntime.getCameraBookmark(id);
    if (updatedBm) applyCameraViewport(updatedBm, bookmarkViewportStage);
    refreshConstraintsUI();
    cameraBookmarksPanel.refresh();
    bookmarkNavigator.refresh();
  });
  cameraConstraintsSection.appendChild(resetConstraintsBtn);

  refreshConstraintsUI = () => {
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    const bm = id ? editorRuntime.getCameraBookmark(id) : null;
    if (bm) {
      constraintsHint.style.display = "none";
      constraintsHint.textContent = "Select a bookmark to edit its constraints";
      constraintsRows.style.display = "flex";
      resetConstraintsBtn.style.display = "block";
      resetConstraintsBtn.disabled = false;
      constraintsTitle.textContent = `Constraints: ${bm.name}`;
      xRow.minInp.value = String(bm.azimuthMin ?? -180);
      xRow.maxInp.value = String(bm.azimuthMax ?? 180);
      yRow.minInp.value = String(bm.polarMin ?? 5);
      yRow.maxInp.value = String(bm.polarMax ?? 175);
      xRow.minInp.disabled = false;
      xRow.maxInp.disabled = false;
      yRow.minInp.disabled = false;
      yRow.maxInp.disabled = false;
      fovInp.value = String(bm.fov ?? 60);
      fovInp.disabled = false;
      zoomDistRow.minInp.value = String(bm.minDistance ?? 0);
      zoomDistRow.maxInp.value =
        bm.maxDistance !== undefined && Number.isFinite(bm.maxDistance)
          ? String(bm.maxDistance)
          : "";
      zoomDistRow.minInp.disabled = false;
      zoomDistRow.maxInp.disabled = false;
      modeOrbit.disabled = false;
      modeFree.disabled = false;
      syncCameraModeRadios();
    } else {
      constraintsHint.style.display = "block";
      constraintsHint.textContent =
        "Select a bookmark to edit all fields, or set Control for the next bookmark you add.";
      constraintsRows.style.display = "flex";
      resetConstraintsBtn.style.display = "none";
      constraintsTitle.textContent = "Camera constraints";
      xRow.minInp.disabled = true;
      xRow.maxInp.disabled = true;
      yRow.minInp.disabled = true;
      yRow.maxInp.disabled = true;
      fovInp.disabled = true;
      zoomDistRow.minInp.disabled = true;
      zoomDistRow.maxInp.disabled = true;
      modeOrbit.disabled = false;
      modeFree.disabled = false;
      syncCameraModeRadios();
    }
  };

  const commitConstraint = (axis: "x" | "y") => {
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    if (!id) return;
    const bm = editorRuntime.getCameraBookmark(id);
    if (!bm) return;
    if (axis === "x") {
      const mn = parseFloat(xRow.minInp.value);
      const mx = parseFloat(xRow.maxInp.value);
      if (!Number.isNaN(mn)) editorRuntime.updateCameraBookmark(id, { azimuthMin: mn });
      if (!Number.isNaN(mx)) editorRuntime.updateCameraBookmark(id, { azimuthMax: mx });
    } else {
      const mn = parseFloat(yRow.minInp.value);
      const mx = parseFloat(yRow.maxInp.value);
      if (!Number.isNaN(mn)) editorRuntime.updateCameraBookmark(id, { polarMin: mn });
      if (!Number.isNaN(mx)) editorRuntime.updateCameraBookmark(id, { polarMax: mx });
    }
    const updated = editorRuntime.getCameraBookmark(id);
    if (updated) applyCameraViewport(updated, bookmarkViewportStage);
    cameraBookmarksPanel.refresh();
    bookmarkNavigator.refresh();
  };
  xRow.minInp.addEventListener("change", () => commitConstraint("x"));
  xRow.minInp.addEventListener("blur", () => commitConstraint("x"));
  xRow.maxInp.addEventListener("change", () => commitConstraint("x"));
  xRow.maxInp.addEventListener("blur", () => commitConstraint("x"));
  yRow.minInp.addEventListener("change", () => commitConstraint("y"));
  yRow.minInp.addEventListener("blur", () => commitConstraint("y"));
  yRow.maxInp.addEventListener("change", () => commitConstraint("y"));
  yRow.maxInp.addEventListener("blur", () => commitConstraint("y"));

  const commitFov = () => {
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    if (!id) return;
    const v = parseFloat(fovInp.value);
    if (!Number.isNaN(v)) {
      editorRuntime.updateCameraBookmark(id, { fov: v });
      const updated = editorRuntime.getCameraBookmark(id);
      if (updated) applyCameraViewport(updated, bookmarkViewportStage);
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    }
  };
  fovInp.addEventListener("change", commitFov);
  fovInp.addEventListener("blur", commitFov);

  const commitZoomDist = () => {
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    if (!id) return;
    const mn = parseFloat(zoomDistRow.minInp.value);
    const maxRaw = zoomDistRow.maxInp.value.trim();
    const patch: {
      minDistance?: number;
      maxDistance?: number;
      clearMaxDistance?: boolean;
    } = {};
    if (!Number.isNaN(mn)) patch.minDistance = mn;
    if (maxRaw === "") patch.clearMaxDistance = true;
    else {
      const mx = parseFloat(maxRaw);
      if (!Number.isNaN(mx)) patch.maxDistance = mx;
    }
    if (Object.keys(patch).length > 0) {
      editorRuntime.updateCameraBookmark(id, patch);
      const updated = editorRuntime.getCameraBookmark(id);
      if (updated) applyCameraViewport(updated, bookmarkViewportStage);
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    }
  };
  zoomDistRow.minInp.addEventListener("change", commitZoomDist);
  zoomDistRow.minInp.addEventListener("blur", commitZoomDist);
  zoomDistRow.maxInp.addEventListener("change", commitZoomDist);
  zoomDistRow.maxInp.addEventListener("blur", commitZoomDist);

  refreshConstraintsUI();
  rightPanel.appendChild(cameraConstraintsSection);

  // Depth of field (per-bookmark)
  const dofSection = document.createElement("div");
  dofSection.className = "camera-dof-section";
  const dofHeader = document.createElement("div");
  dofHeader.className = "camera-dof-header";
  const dofTitle = document.createElement("h4");
  dofTitle.textContent = "Depth of field";
  const dofToggleBtn = document.createElement("button");
  dofToggleBtn.type = "button";
  dofToggleBtn.className = "camera-dof-toggle-btn";
  dofToggleBtn.title = "Toggle depth of field effect";
  function updateDofToggleLabel(): void {
    dofToggleBtn.textContent = dofEnabled ? "Desactivar DoF" : "Activar DoF";
  }
  updateDofToggleLabel();
  dofToggleBtn.addEventListener("click", () => {
    dofEnabled = !dofEnabled;
    updateDofToggleLabel();
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    const bm = id ? editorRuntime.getCameraBookmark(id) : null;
    if (bm) applyBookmarkDoF(bm);
    else if (!dofEnabled) runtime.spark.apertureAngle = 0;
    else {
      runtime.spark.focalDistance = 5;
      runtime.spark.apertureAngle = 2 * Math.atan(0.5 * 0.1 / 5);
    }
  });
  dofHeader.appendChild(dofTitle);
  dofHeader.appendChild(dofToggleBtn);
  dofSection.appendChild(dofHeader);
  const dofHint = document.createElement("div");
  dofHint.className = "camera-dof-hint";
  dofHint.textContent = "Select a bookmark to edit DoF";
  dofSection.appendChild(dofHint);
  const dofRows = document.createElement("div");
  dofRows.className = "camera-dof-rows";
  const createDoFRow = (label: string, min: number, max: number, step: number) => {
    const row = document.createElement("div");
    row.className = "camera-dof-row";
    const labelSpan = document.createElement("span");
    labelSpan.className = "camera-dof-label";
    labelSpan.textContent = label;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.className = "camera-dof-slider";
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = String(step);
    inp.min = String(min);
    inp.max = String(max);
    inp.className = "camera-dof-input";
    row.appendChild(labelSpan);
    row.appendChild(slider);
    row.appendChild(inp);
    return { row, slider, inp };
  };
  const focalRow = createDoFRow("Focal plane dist", 0, 15, 0.01);
  const apertureRow = createDoFRow("Aperture size", 0, 0.4, 0.01);
  dofRows.appendChild(focalRow.row);
  dofRows.appendChild(apertureRow.row);
  dofSection.appendChild(dofRows);

  const syncDoFInputs = (fd: number, ap: number) => {
    focalRow.slider.value = String(fd);
    focalRow.inp.value = String(fd);
    apertureRow.slider.value = String(ap);
    apertureRow.inp.value = String(ap);
  };
  const commitDoF = () => {
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    if (!id) return;
    const fd = parseFloat(focalRow.inp.value);
    const ap = parseFloat(apertureRow.inp.value);
    const updates: { focalDistance?: number; apertureSize?: number } = {};
    if (!Number.isNaN(fd)) updates.focalDistance = fd;
    if (!Number.isNaN(ap)) updates.apertureSize = ap;
    if (Object.keys(updates).length === 0) return;
    editorRuntime.updateCameraBookmark(id, updates);
    const bm = editorRuntime.getCameraBookmark(id);
    if (bm) applyBookmarkDoF(bm);
    cameraBookmarksPanel.refresh();
    bookmarkNavigator.refresh();
  };
  focalRow.slider.addEventListener("input", () => {
    const v = parseFloat(focalRow.slider.value);
    focalRow.inp.value = String(v);
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    if (id) {
      editorRuntime.updateCameraBookmark(id, { focalDistance: v });
      const bm = editorRuntime.getCameraBookmark(id);
      if (bm) applyBookmarkDoF(bm);
    }
  });
  apertureRow.slider.addEventListener("input", () => {
    const v = parseFloat(apertureRow.slider.value);
    apertureRow.inp.value = String(v);
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    if (id) {
      editorRuntime.updateCameraBookmark(id, { apertureSize: v });
      const bm = editorRuntime.getCameraBookmark(id);
      if (bm) applyBookmarkDoF(bm);
    }
  });
  focalRow.inp.addEventListener("change", commitDoF);
  focalRow.inp.addEventListener("blur", commitDoF);
  apertureRow.inp.addEventListener("change", commitDoF);
  apertureRow.inp.addEventListener("blur", commitDoF);

  refreshDoFUI = () => {
    const id = cameraBookmarksPanel.getSelectedBookmarkId();
    const bm = id ? editorRuntime.getCameraBookmark(id) : null;
    if (bm) {
      dofHint.style.display = "none";
      dofRows.style.display = "flex";
      dofTitle.textContent = `DoF: ${bm.name}`;
      syncDoFInputs(bm.focalDistance ?? 5, bm.apertureSize ?? 0.1);
      focalRow.slider.disabled = false;
      focalRow.inp.disabled = false;
      apertureRow.slider.disabled = false;
      apertureRow.inp.disabled = false;
    } else {
      dofHint.style.display = "block";
      dofRows.style.display = "none";
      dofTitle.textContent = "Depth of field";
    }
  };
  refreshDoFUI();
  rightPanel.appendChild(dofSection);

  // Parametric transform controls
  const transformParamsPanel = createTransformParamsPanel({
    getTransform: () =>
      editingChangan3D
        ? getChangan3DTransform()
        : editingBlackdrop
        ? getBlackdropTransform()
        : editingDealership
          ? getDealershipTransform()
          : editingFloor
            ? getFloorTransform()
            : editingCeiling
              ? getCeilingTransform()
              : editingContactShadow
                ? getContactShadowTransform()
                : editingNameplate3d
                  ? getNameplate3dTransform()
                  : editorRuntime.getActiveAssetDef()?.transform ?? null,
    onTransformChange: (partial) => {
      if (editingChangan3D) {
        const t: TransformDef = {
          ...getChangan3DTransform(),
          ...(partial.pos !== undefined && { pos: partial.pos }),
          ...(partial.rot !== undefined && { rot: partial.rot }),
          ...(partial.scale !== undefined && { scale: partial.scale }),
        };
        manifestDraft.updateChangan3DTransform(t);
        applyChangan3DTransform(t);
        transformGizmos.setTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingBlackdrop) {
        const t: TransformDef = {
          ...getBlackdropTransform(),
          ...(partial.pos !== undefined && { pos: partial.pos }),
          ...(partial.rot !== undefined && { rot: partial.rot }),
          ...(partial.scale !== undefined && { scale: partial.scale }),
        };
        manifestDraft.updateBlackdropTransform(t);
        applyBlackdropTransform(t);
        transformGizmos.setTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingDealership) {
        const t: TransformDef = {
          ...getDealershipTransform(),
          ...(partial.pos !== undefined && { pos: partial.pos }),
          ...(partial.rot !== undefined && { rot: partial.rot }),
          ...(partial.scale !== undefined && { scale: partial.scale }),
        };
        manifestDraft.updateDealershipTransform(t);
        applyDealershipTransform(t);
        transformGizmos.setTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingFloor) {
        const t: TransformDef = {
          ...getFloorTransform(),
          ...(partial.pos !== undefined && { pos: partial.pos }),
          ...(partial.rot !== undefined && { rot: partial.rot }),
          ...(partial.scale !== undefined && { scale: partial.scale }),
        };
        manifestDraft.updateFloorTransform(t);
        applyFloorTransform(t);
        transformGizmos.setTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingCeiling) {
        const t: TransformDef = {
          ...getCeilingTransform(),
          ...(partial.pos !== undefined && { pos: partial.pos }),
          ...(partial.rot !== undefined && { rot: partial.rot }),
          ...(partial.scale !== undefined && { scale: partial.scale }),
        };
        manifestDraft.updateCeilingTransform(t);
        applyCeilingTransform(t);
        transformGizmos.setTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingContactShadow) {
        const t: TransformDef = {
          ...getContactShadowTransform(),
          ...(partial.pos !== undefined && { pos: partial.pos }),
          ...(partial.rot !== undefined && { rot: partial.rot }),
          ...(partial.scale !== undefined && { scale: partial.scale }),
        };
        manifestDraft.updateContactShadowTransform(editorRuntime.state.modelId, t);
        applyContactShadowFromManifest(editorRuntime.state.modelId);
        transformGizmos.setTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingNameplate3d) {
        const t: TransformDef = {
          ...getNameplate3dTransform(),
          ...(partial.pos !== undefined && { pos: partial.pos }),
          ...(partial.rot !== undefined && { rot: partial.rot }),
          ...(partial.scale !== undefined && { scale: partial.scale }),
        };
        manifestDraft.updateNameplate3dTransform(editorRuntime.state.modelId, t);
        applyNameplate3dTransform(t);
        transformGizmos.setTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      const asset = editorRuntime.getActiveAssetDef();
      if (!asset || !transformGroupRef) return;
      const t: AssetDef["transform"] = {
        ...asset.transform,
        ...(partial.pos !== undefined && { pos: partial.pos }),
        ...(partial.rot !== undefined && { rot: partial.rot }),
        ...(partial.scale !== undefined && { scale: partial.scale }),
      };
      editorRuntime.updateTransform(t);
      transformGroupRef.position.set(t.pos[0], t.pos[1], t.pos[2]);
      transformGroupRef.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
      const [sx, sy, sz] = getScale(t);
      transformGroupRef.scale.set(sx, sy, sz);
      transformGizmos.setTransform(t);
      transformParamsPanel.refresh();
    },
    onPivotChange: (pivot, pivotRot) => {
      if (
        editingDealership ||
        editingFloor ||
        editingCeiling ||
        editingBlackdrop ||
        editingChangan3D ||
        editingNameplate3d ||
        editingContactShadow
      )
        return;
      if (!meshRef) return;
      editorRuntime.updatePivot(pivot, pivotRot);
      const resolvedPivotRot = pivotRot ?? getPivotRot(editorRuntime.getActiveAssetDef()!.transform);
      transformGizmos.applyPivotToMesh(meshRef.mesh, pivot, resolvedPivotRot);
      transformParamsPanel.refresh();
    },
    getPivotData: () => {
      if (
        editingDealership ||
        editingFloor ||
        editingCeiling ||
        editingBlackdrop ||
        editingChangan3D ||
        editingNameplate3d ||
        editingContactShadow
      )
        return null;
      const asset = editorRuntime.getActiveAssetDef();
      if (!asset) return null;
      return {
        pivot: getPivot(asset.transform),
        pivotRot: getPivotRot(asset.transform),
      };
    },
  });
  const contactShadowOpacityWrap = document.createElement("div");
  contactShadowOpacityWrap.className = "contact-shadow-opacity-wrap";
  const contactShadowBlobBlockTitle = document.createElement("div");
  contactShadowBlobBlockTitle.className = "contact-shadow-gradient-title";
  contactShadowBlobBlockTitle.textContent = "Blob (rounded rectangle)";
  contactShadowOpacityWrap.appendChild(contactShadowBlobBlockTitle);
  const contactShadowOpacityLabel = document.createElement("label");
  contactShadowOpacityLabel.className = "contact-shadow-opacity-label";
  contactShadowOpacityLabel.textContent = "Opacity";
  const contactShadowOpacityInput = document.createElement("input");
  contactShadowOpacityInput.type = "number";
  contactShadowOpacityInput.min = "0";
  contactShadowOpacityInput.max = "1";
  contactShadowOpacityInput.step = "0.05";
  contactShadowOpacityInput.className = "contact-shadow-opacity-input";
  contactShadowOpacityInput.title = "Opacity of the floor contact shadow (0–1)";
  contactShadowOpacityInput.addEventListener("change", () => {
    if (!editingContactShadow) return;
    const v = Number(contactShadowOpacityInput.value);
    if (!Number.isFinite(v)) return;
    const mid = editorRuntime.state.modelId;
    manifestDraft.updateContactShadowOpacity(mid, v);
    applyContactShadowFromManifest(mid);
    transformParamsPanel.refresh();
  });
  contactShadowOpacityLabel.appendChild(contactShadowOpacityInput);
  contactShadowOpacityWrap.appendChild(contactShadowOpacityLabel);

  const contactShadowCornerLabel = document.createElement("label");
  contactShadowCornerLabel.className = "contact-shadow-opacity-label";
  contactShadowCornerLabel.textContent = "Corner radius";
  const contactShadowCornerInput = document.createElement("input");
  contactShadowCornerInput.type = "number";
  contactShadowCornerInput.min = "0";
  contactShadowCornerInput.max = "1";
  contactShadowCornerInput.step = "0.02";
  contactShadowCornerInput.className = "contact-shadow-opacity-input";
  contactShadowCornerInput.title =
    "Roundness of corners 0–1 (fraction of the shorter half-side of the blob, before scale)";
  contactShadowCornerInput.addEventListener("change", () => {
    if (!editingContactShadow) return;
    const v = Number(contactShadowCornerInput.value);
    if (!Number.isFinite(v)) return;
    const mid = editorRuntime.state.modelId;
    manifestDraft.updateContactShadowCornerRadius(mid, v);
    applyContactShadowFromManifest(mid);
    transformParamsPanel.refresh();
  });
  contactShadowCornerLabel.appendChild(contactShadowCornerInput);
  contactShadowOpacityWrap.appendChild(contactShadowCornerLabel);

  const contactShadowGradientWrap = document.createElement("div");
  contactShadowGradientWrap.className = "contact-shadow-gradient-wrap";
  const gradTitle = document.createElement("div");
  gradTitle.className = "contact-shadow-gradient-title";
  gradTitle.textContent = "Contact shadow gradient";
  contactShadowGradientWrap.appendChild(gradTitle);

  const mkGradInput = (
    label: string,
    key: "centerAlpha" | "midStop" | "midAlpha",
    opts: { min: string; max: string; step: string; title: string }
  ) => {
    const row = document.createElement("label");
    row.className = "contact-shadow-gradient-row";
    const lab = document.createElement("span");
    lab.textContent = label;
    row.appendChild(lab);
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = opts.min;
    inp.max = opts.max;
    inp.step = opts.step;
    inp.className = "contact-shadow-gradient-input";
    inp.title = opts.title;
    inp.addEventListener("change", () => {
      if (!editingContactShadow) return;
      const v = Number(inp.value);
      if (!Number.isFinite(v)) return;
      const mid = editorRuntime.state.modelId;
      manifestDraft.updateContactShadowGradient(mid, { [key]: v });
      applyContactShadowFromManifest(mid);
      transformParamsPanel.refresh();
    });
    row.appendChild(inp);
    contactShadowGradientWrap.appendChild(row);
    return inp;
  };

  const contactShadowGradCenterInput = mkGradInput("Center α", "centerAlpha", {
    min: "0",
    max: "1",
    step: "0.05",
    title: "Alpha at disk center (0–1)",
  });
  const contactShadowGradMidStopInput = mkGradInput("Mid radius", "midStop", {
    min: "0.02",
    max: "0.999",
    step: "0.02",
    title: "Normalized radius of the mid falloff (0–1)",
  });
  const contactShadowGradMidAlphaInput = mkGradInput("Mid α", "midAlpha", {
    min: "0",
    max: "1",
    step: "0.05",
    title: "Alpha at the mid stop (0–1)",
  });

  const _origTransformParamsRefresh = transformParamsPanel.refresh.bind(transformParamsPanel);
  transformParamsPanel.refresh = () => {
    _origTransformParamsRefresh();
    const mid = editorRuntime.state.modelId;
    const cs = manifestDraft.manifest.models.find((x) => x.id === mid)?.contactShadow;
    const g = resolveContactShadowGradient(cs?.gradient);
    const gradDisabled = !editingContactShadow;
    contactShadowOpacityInput.disabled = gradDisabled;
    contactShadowCornerInput.disabled = gradDisabled;
    contactShadowGradCenterInput.disabled = gradDisabled;
    contactShadowGradMidStopInput.disabled = gradDisabled;
    contactShadowGradMidAlphaInput.disabled = gradDisabled;
    const op = cs?.opacity ?? 0.9;
    contactShadowOpacityInput.value = String(op);
    contactShadowCornerInput.value = String(resolveContactShadowCornerRadius(cs?.cornerRadius));
    contactShadowGradCenterInput.value = String(g.centerAlpha);
    contactShadowGradMidStopInput.value = String(g.midStop);
    contactShadowGradMidAlphaInput.value = String(g.midAlpha);
  };

  rightPanel.appendChild(transformParamsPanel.el);
  rightPanel.appendChild(contactShadowOpacityWrap);
  rightPanel.appendChild(contactShadowGradientWrap);

  // Color range selection and editing
  const colorRangePanel = createColorRangePanel({
    getMesh: () => meshRef?.mesh ?? null,
    getRenderer: () => runtime.renderer,
    getCanvas: () => canvas,
    getCamera: () => runtime.camera,
    canvasContainer: canvasArea,
    getSpark: () => runtime.spark,
    getScene: () => runtime.scene,
  });
  rightPanel.appendChild(colorRangePanel.el);

  // Preview link – opens showroom (different port) which fetches from editor bridge
  const previewLink = document.createElement("a");
  previewLink.href = remoteManifestApi ? viewerApiOrigin : "http://localhost:5175";
  previewLink.title = "Open showroom. Click Refresh there to see editor changes.";
  previewLink.className = "preview-link";
  previewLink.textContent = "Preview";
  previewLink.title = "Open showroom to see your setup";
  previewLink.target = "_blank";
  rightPanel.appendChild(previewLink);

  const dealershipBtn = document.createElement("button");
  dealershipBtn.type = "button";
  dealershipBtn.className = "dealership-toggle-btn";
  dealershipBtn.textContent = dealershipVisible ? "Hide dealership" : "Show dealership";
  dealershipBtn.title = "Toggle car dealership background";
  dealershipBtn.addEventListener("click", () => {
    dealershipVisible = !dealershipVisible;
    if (dealershipVisible && !dealershipEnvRequested) {
      // Started with ?backdrop=1 — the env was never fetched; load it on demand.
      dealershipEnvRequested = true;
      void loadDealership();
      void loadFloor();
      void loadCeiling();
      void loadPanoBackground();
    }
    dealershipGroup.visible = dealershipVisible;
    floorGroup.visible = dealershipVisible;
    ceilingGroup.visible = dealershipVisible;
    panoGroup.visible = dealershipVisible;
    dealershipBtn.textContent = dealershipVisible ? "Hide dealership" : "Show dealership";
  });
  rightPanel.appendChild(dealershipBtn);

  const editDealershipBtn = document.createElement("button");
  editDealershipBtn.type = "button";
  editDealershipBtn.className = "dealership-edit-btn";
  const updateEditDealershipBtnLabel = () => {
    editDealershipBtn.textContent = editingDealership ? "Done editing" : "Edit dealership";
    editDealershipBtn.title = editingDealership ? "Finish editing dealership" : "Edit dealership position and rotation";
  };
  updateEditDealershipBtnLabel();
  editDealershipBtn.addEventListener("click", () => {
    editingDealership = !editingDealership;
    if (editingDealership) {
      editingNameplate3d = false;
      editingContactShadow = false;
      if (editingFloor) {
        editingFloor = false;
        updateEditFloorBtnLabel();
      }
      if (editingCeiling) {
        editingCeiling = false;
        updateEditCeilingBtnLabel();
      }
      if (editingBlackdrop) {
        editingBlackdrop = false;
        updateEditBlackdropBtnLabel();
      }
      if (editingChangan3D) {
        editingChangan3D = false;
        updateEditChangan3dBtnLabel();
      }
      if (editingPano) {
        editingPano = false;
        updateEditPanoBtnLabel();
      }
      selectedBookmarkIdRef = null;
      isEditingBookmarkPivot = false;
      pivotProxy.visible = false;
      transformGizmos.setTarget(dealershipGroup);
      transformGizmos.setMode("translate");
      transformGizmos.setTransform(getDealershipTransform());
      cameraBookmarksPanel.setSelectedBookmarkId(null);
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    } else {
      applyGizmoTargetAndMode();
    }
    transformParamsPanel.refresh();
    updateEditDealershipBtnLabel();
  });
  rightPanel.appendChild(editDealershipBtn);

  const editFloorBtn = document.createElement("button");
  editFloorBtn.type = "button";
  editFloorBtn.className = "floor-edit-btn";
  updateEditFloorBtnLabel = () => {
    editFloorBtn.textContent = editingFloor ? "Done editing floor" : "Edit floor";
    editFloorBtn.title = editingFloor
      ? "Finish editing floor.glb"
      : "Edit floor plane (splats/floor.glb) transform";
  };
  updateEditFloorBtnLabel();
  editFloorBtn.addEventListener("click", () => {
    editingFloor = !editingFloor;
    if (editingFloor) {
      editingNameplate3d = false;
      editingContactShadow = false;
      if (editingDealership) {
        editingDealership = false;
        updateEditDealershipBtnLabel();
      }
      if (editingBlackdrop) {
        editingBlackdrop = false;
        updateEditBlackdropBtnLabel();
      }
      if (editingChangan3D) {
        editingChangan3D = false;
        updateEditChangan3dBtnLabel();
      }
      if (editingPano) {
        editingPano = false;
        updateEditPanoBtnLabel();
      }
      if (editingCeiling) {
        editingCeiling = false;
        updateEditCeilingBtnLabel();
      }
      selectedBookmarkIdRef = null;
      isEditingBookmarkPivot = false;
      pivotProxy.visible = false;
      transformGizmos.setTarget(floorGroup);
      transformGizmos.setMode("translate");
      transformGizmos.setTransform(getFloorTransform());
      syncFloorBrightnessInput();
      cameraBookmarksPanel.setSelectedBookmarkId(null);
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    } else {
      applyGizmoTargetAndMode();
    }
    transformParamsPanel.refresh();
    updateEditFloorBtnLabel();
  });
  rightPanel.appendChild(editFloorBtn);

  const floorBrightnessWrap = document.createElement("div");
  floorBrightnessWrap.className = "floor-brightness-wrap";
  const floorBrightnessLabel = document.createElement("label");
  floorBrightnessLabel.className = "floor-brightness-label";
  floorBrightnessLabel.textContent = "Floor brightness";
  const floorBrightnessInput = document.createElement("input");
  floorBrightnessInput.type = "range";
  floorBrightnessInput.min = "0";
  floorBrightnessInput.max = "2";
  floorBrightnessInput.step = "0.02";
  floorBrightnessInput.className = "floor-brightness-range";
  floorBrightnessInput.title = "Multiplies floor material color (0–2)";
  const syncFloorBrightnessInput = (): void => {
    const b = manifestDraft.manifest.floor?.brightness;
    floorBrightnessInput.value = String(b !== undefined && Number.isFinite(b) ? b : 1);
  };
  syncFloorBrightnessInput();
  floorBrightnessInput.addEventListener("input", () => {
    const v = parseFloat(floorBrightnessInput.value);
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(0, Math.min(4, v));
    manifestDraft.patchManifest((mm) => {
      mm.floor ??= { transform: { ...DEFAULT_FLOOR_TRANSFORM }, brightness: 1 };
      mm.floor.brightness = clamped;
    });
    applyFloorBrightness(floorGroup, manifestDraft.manifest.floor?.brightness);
    fetch(
      MANIFEST_DRAFT_POST_URL,
      manifestAuthFetchInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifestDraft.manifest),
      })
    ).catch(() => {});
  });
  floorBrightnessLabel.appendChild(floorBrightnessInput);
  floorBrightnessWrap.appendChild(floorBrightnessLabel);
  rightPanel.appendChild(floorBrightnessWrap);

  const editCeilingBtn = document.createElement("button");
  editCeilingBtn.type = "button";
  editCeilingBtn.className = "ceiling-edit-btn";
  updateEditCeilingBtnLabel = () => {
    editCeilingBtn.textContent = editingCeiling ? "Done editing ceiling" : "Edit ceiling";
    editCeilingBtn.title = editingCeiling
      ? "Finish editing ceiling.glb"
      : "Edit ceiling (splats/ceiling.glb) transform";
  };
  updateEditCeilingBtnLabel();
  editCeilingBtn.addEventListener("click", () => {
    editingCeiling = !editingCeiling;
    if (editingCeiling) {
      editingNameplate3d = false;
      editingContactShadow = false;
      if (editingDealership) {
        editingDealership = false;
        updateEditDealershipBtnLabel();
      }
      if (editingFloor) {
        editingFloor = false;
        updateEditFloorBtnLabel();
      }
      if (editingBlackdrop) {
        editingBlackdrop = false;
        updateEditBlackdropBtnLabel();
      }
      if (editingChangan3D) {
        editingChangan3D = false;
        updateEditChangan3dBtnLabel();
      }
      if (editingPano) {
        editingPano = false;
        updateEditPanoBtnLabel();
      }
      selectedBookmarkIdRef = null;
      isEditingBookmarkPivot = false;
      pivotProxy.visible = false;
      transformGizmos.setTarget(ceilingGroup);
      transformGizmos.setMode("translate");
      transformGizmos.setTransform(getCeilingTransform());
      syncCeilingBrightnessInput();
      cameraBookmarksPanel.setSelectedBookmarkId(null);
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    } else {
      applyGizmoTargetAndMode();
    }
    transformParamsPanel.refresh();
    updateEditCeilingBtnLabel();
  });
  rightPanel.appendChild(editCeilingBtn);

  const ceilingBrightnessWrap = document.createElement("div");
  ceilingBrightnessWrap.className = "ceiling-brightness-wrap";
  const ceilingBrightnessLabel = document.createElement("label");
  ceilingBrightnessLabel.className = "ceiling-brightness-label";
  ceilingBrightnessLabel.textContent = "Ceiling brightness";
  const ceilingBrightnessInput = document.createElement("input");
  ceilingBrightnessInput.type = "range";
  ceilingBrightnessInput.min = "0";
  ceilingBrightnessInput.max = "2";
  ceilingBrightnessInput.step = "0.02";
  ceilingBrightnessInput.className = "ceiling-brightness-range";
  ceilingBrightnessInput.title = "Multiplies ceiling material color (0–2)";
  const syncCeilingBrightnessInput = (): void => {
    const b = manifestDraft.manifest.ceiling?.brightness;
    ceilingBrightnessInput.value = String(b !== undefined && Number.isFinite(b) ? b : 1);
  };
  syncCeilingBrightnessInput();
  ceilingBrightnessInput.addEventListener("input", () => {
    const v = parseFloat(ceilingBrightnessInput.value);
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(0, Math.min(4, v));
    manifestDraft.patchManifest((mm) => {
      mm.ceiling ??= { transform: { ...DEFAULT_CEILING_TRANSFORM }, brightness: 1 };
      mm.ceiling.brightness = clamped;
    });
    applyCeilingBrightness(ceilingGroup, manifestDraft.manifest.ceiling?.brightness);
    fetch(
      MANIFEST_DRAFT_POST_URL,
      manifestAuthFetchInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifestDraft.manifest),
      })
    ).catch(() => {});
  });
  ceilingBrightnessLabel.appendChild(ceilingBrightnessInput);
  ceilingBrightnessWrap.appendChild(ceilingBrightnessLabel);
  rightPanel.appendChild(ceilingBrightnessWrap);

  const blackdropToggleBtn = document.createElement("button");
  blackdropToggleBtn.type = "button";
  blackdropToggleBtn.className = "blackdrop-toggle-btn";
  blackdropToggleBtn.textContent = blackdropVisible ? "Hide blackdrop" : "Show blackdrop";
  blackdropToggleBtn.title = "Toggle GLB backdrop (blackdrop.glb)";
  blackdropToggleBtn.addEventListener("click", () => {
    blackdropVisible = !blackdropVisible;
    blackdropGroup.visible = blackdropVisible;
    changan3dGroup.visible = blackdropVisible;
    blackdropToggleBtn.textContent = blackdropVisible ? "Hide blackdrop" : "Show blackdrop";
    if (!blackdropVisible && editingChangan3D) {
      editingChangan3D = false;
      applyGizmoTargetAndMode();
      transformParamsPanel.refresh();
    }
    updateEditChangan3dBtnLabel();
  });
  rightPanel.appendChild(blackdropToggleBtn);

  const editBlackdropBtn = document.createElement("button");
  editBlackdropBtn.type = "button";
  editBlackdropBtn.className = "blackdrop-edit-btn";
  const updateEditBlackdropBtnLabel = () => {
    editBlackdropBtn.textContent = editingBlackdrop ? "Done editing blackdrop" : "Edit blackdrop";
    editBlackdropBtn.title = editingBlackdrop
      ? "Finish editing blackdrop"
      : "Edit blackdrop position, rotation, and scale";
  };
  updateEditBlackdropBtnLabel();
  editBlackdropBtn.addEventListener("click", () => {
    editingBlackdrop = !editingBlackdrop;
    if (editingBlackdrop) {
      editingNameplate3d = false;
      editingContactShadow = false;
      if (editingDealership) {
        editingDealership = false;
        updateEditDealershipBtnLabel();
      }
      if (editingFloor) {
        editingFloor = false;
        updateEditFloorBtnLabel();
      }
      if (editingCeiling) {
        editingCeiling = false;
        updateEditCeilingBtnLabel();
      }
      if (editingChangan3D) {
        editingChangan3D = false;
        updateEditChangan3dBtnLabel();
      }
      if (editingPano) {
        editingPano = false;
        updateEditPanoBtnLabel();
      }
      selectedBookmarkIdRef = null;
      isEditingBookmarkPivot = false;
      pivotProxy.visible = false;
      transformGizmos.setTarget(blackdropGroup);
      transformGizmos.setMode("translate");
      transformGizmos.setTransform(getBlackdropTransform());
      cameraBookmarksPanel.setSelectedBookmarkId(null);
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    } else {
      applyGizmoTargetAndMode();
    }
    transformParamsPanel.refresh();
    updateEditBlackdropBtnLabel();
  });
  rightPanel.appendChild(editBlackdropBtn);

  const editChangan3dBtn = document.createElement("button");
  editChangan3dBtn.type = "button";
  editChangan3dBtn.className = "changan3d-edit-btn";
  updateEditChangan3dBtnLabel = () => {
    editChangan3dBtn.textContent = editingChangan3D ? "Done editing Foton 3D" : "Edit Foton 3D";
    editChangan3dBtn.title = editingChangan3D
      ? "Finish editing the Foton 3D GLB transform"
      : "Edit Foton 3D (visible only while blackdrop is shown)";
    editChangan3dBtn.disabled = !blackdropVisible;
  };
  updateEditChangan3dBtnLabel();
  editChangan3dBtn.addEventListener("click", () => {
    if (!blackdropVisible) return;
    editingChangan3D = !editingChangan3D;
    if (editingChangan3D) {
      editingNameplate3d = false;
      editingContactShadow = false;
      if (editingDealership) {
        editingDealership = false;
        updateEditDealershipBtnLabel();
      }
      if (editingFloor) {
        editingFloor = false;
        updateEditFloorBtnLabel();
      }
      if (editingCeiling) {
        editingCeiling = false;
        updateEditCeilingBtnLabel();
      }
      if (editingBlackdrop) {
        editingBlackdrop = false;
        updateEditBlackdropBtnLabel();
      }
      if (editingPano) {
        editingPano = false;
        updateEditPanoBtnLabel();
      }
      selectedBookmarkIdRef = null;
      isEditingBookmarkPivot = false;
      pivotProxy.visible = false;
      transformGizmos.setTarget(changan3dGroup);
      transformGizmos.setMode("translate");
      transformGizmos.setTransform(getChangan3DTransform());
      cameraBookmarksPanel.setSelectedBookmarkId(null);
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    } else {
      applyGizmoTargetAndMode();
    }
    transformParamsPanel.refresh();
    updateEditChangan3dBtnLabel();
  });
  rightPanel.appendChild(editChangan3dBtn);

  const editPanoBtn = document.createElement("button");
  editPanoBtn.type = "button";
  editPanoBtn.className = "pano-edit-btn";
  updateEditPanoBtnLabel = () => {
    editPanoBtn.textContent = editingPano ? "Done editing pano" : "Edit pano background";
    editPanoBtn.title = editingPano
      ? "Finish editing the equirect background sphere"
      : "Edit panorama position / rotation / scale";
  };
  updateEditPanoBtnLabel();
  editPanoBtn.addEventListener("click", () => {
    editingPano = !editingPano;
    if (editingPano) {
      editingNameplate3d = false;
      editingContactShadow = false;
      if (editingDealership) {
        editingDealership = false;
        updateEditDealershipBtnLabel();
      }
      if (editingFloor) {
        editingFloor = false;
        updateEditFloorBtnLabel();
      }
      if (editingCeiling) {
        editingCeiling = false;
        updateEditCeilingBtnLabel();
      }
      if (editingBlackdrop) {
        editingBlackdrop = false;
        updateEditBlackdropBtnLabel();
      }
      if (editingChangan3D) {
        editingChangan3D = false;
        updateEditChangan3dBtnLabel();
      }
      selectedBookmarkIdRef = null;
      isEditingBookmarkPivot = false;
      pivotProxy.visible = false;
      // Ensure the pano draft entry exists so the gizmo writes back into the manifest.
      if (!manifestDraft.manifest.panoBackground) {
        manifestDraft.updatePanoBackgroundTransform(getPanoTransform());
      }
      // Snapshot baseline uniform scale so the per-axis gizmo handles can be
      // collapsed to whichever axis the user pulls furthest from this value.
      const initialPanoTransform = getPanoTransform();
      const [psx, psy, psz] = getScale(initialPanoTransform);
      lastPanoUniformScale = (psx + psy + psz) / 3;
      transformGizmos.setTarget(panoGroup);
      transformGizmos.setMode("translate");
      transformGizmos.setTransform(initialPanoTransform);
      cameraBookmarksPanel.setSelectedBookmarkId(null);
      cameraBookmarksPanel.refresh();
      bookmarkNavigator.refresh();
    } else {
      applyGizmoTargetAndMode();
    }
    transformParamsPanel.refresh();
    updateEditPanoBtnLabel();
  });
  rightPanel.appendChild(editPanoBtn);

  const sceneAppearancePanel = createSceneAppearancePanel({
    getManifest: () => manifestDraft.manifest,
    onPatch: (fn) => {
      manifestDraft.patchManifest(fn);
      fetch(
        MANIFEST_DRAFT_POST_URL,
        manifestAuthFetchInit({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(manifestDraft.manifest),
        })
      ).catch(() => {});
    },
    applyVisuals: reapplySceneAppearance,
    getChangan3DDefaultTint: () => readChangan3DDefaultTintHex(changan3dGroup),
  });
  rightPanel.appendChild(sceneAppearancePanel.el);

  // Rescan splats folder (discovers new models, merges with existing, saves & reloads)
  const rescanSplatsBtn = document.createElement("button");
  rescanSplatsBtn.textContent = "Rescan splats";
  rescanSplatsBtn.title = remoteManifestApi
    ? "Only available in local dev (needs splats folder on disk)"
    : "Discover models from splats folder, merge with existing, save and reload";
  if (remoteManifestApi) {
    rescanSplatsBtn.disabled = true;
  }
  rescanSplatsBtn.addEventListener("click", async () => {
    try {
      const res = await fetch(SPLATS_MANIFEST_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("Splats manifest unavailable");
      const discovered = (await res.json()) as SceneManifest;
      if (!discovered?.models?.length) {
        alert(
          "No models found in splats folder. Ensure files follow: " +
            "splats/<modelId>/<modelId>.sog (base), <modelId>-<accessory>.sog (accessories), " +
            "<modelId>-motor.sog, <modelId>-int.sog, <modelId>.glb (3D nameplate)"
        );
        return;
      }
      const existingById = new Map(manifestDraft.manifest.models.map((m) => [m.id, m]));
      const merged: ModelDef[] = [];
      /** Update URL/fileType from discovery; never clobber an existing transform. */
      const mergeAsset = (
        existingAsset: AssetDef | undefined,
        discAsset: AssetDef | undefined
      ): AssetDef | undefined => {
        if (!discAsset) return existingAsset;
        if (!existingAsset) return discAsset;
        return {
          ...existingAsset,
          url: discAsset.url,
          ...(discAsset.fileType != null ? { fileType: discAsset.fileType } : {}),
        };
      };
      for (const disc of discovered.models) {
        const existing = existingById.get(disc.id);
        if (!existing) {
          merged.push(disc);
          continue;
        }
        // Merge: keep existing transforms/bookmarks/annotations/contactShadow/nameplate3d,
        // update asset URLs from discovery, and append newly discovered layers.
        const mergedModel: ModelDef = { ...existing };
        mergedModel.base = mergeAsset(existing.base, disc.base) ?? existing.base;
        const mergedMotor = mergeAsset(existing.motor, disc.motor);
        if (mergedMotor) mergedModel.motor = mergedMotor;
        const mergedInterior = mergeAsset(existing.interior, disc.interior);
        if (mergedInterior) mergedModel.interior = mergedInterior;
        const existingAccIds = new Set(existing.accessories.map((a) => a.id));
        const mergedAccessories: AccessoryDef[] = existing.accessories.map((ea) => {
          const da = disc.accessories.find((a) => a.id === ea.id);
          if (!da) return ea;
          return { ...ea, asset: mergeAsset(ea.asset, da.asset) ?? ea.asset };
        });
        for (const da of disc.accessories) {
          if (!existingAccIds.has(da.id)) mergedAccessories.push(da);
        }
        mergedModel.accessories = mergedAccessories;
        if (!existing.nameplate3d && disc.nameplate3d) {
          mergedModel.nameplate3d = disc.nameplate3d;
        }
        merged.push(mergedModel);
      }
      // Sync dealership transform from scene before merge (ensures visual state is persisted on reload)
      const dPos = dealershipGroup.position;
      const dQuat = dealershipGroup.quaternion;
      const dScale = dealershipGroup.scale;
      if (dPos && dQuat && dScale) {
        manifestDraft.updateDealershipTransform({
          pos: [dPos.x, dPos.y, dPos.z],
          rot: [dQuat.x, dQuat.y, dQuat.z, dQuat.w],
          scale: [dScale.x, dScale.y, dScale.z],
        });
      }
      const bdPos = blackdropGroup.position;
      const bdQuat = blackdropGroup.quaternion;
      const bdScale = blackdropGroup.scale;
      if (bdPos && bdQuat && bdScale) {
        manifestDraft.updateBlackdropTransform({
          pos: [bdPos.x, bdPos.y, bdPos.z],
          rot: [bdQuat.x, bdQuat.y, bdQuat.z, bdQuat.w],
          scale: [bdScale.x, bdScale.y, bdScale.z],
        });
      }
      const c3Pos = changan3dGroup.position;
      const c3Quat = changan3dGroup.quaternion;
      const c3Scale = changan3dGroup.scale;
      if (c3Pos && c3Quat && c3Scale) {
        manifestDraft.updateChangan3DTransform({
          pos: [c3Pos.x, c3Pos.y, c3Pos.z],
          rot: [c3Quat.x, c3Quat.y, c3Quat.z, c3Quat.w],
          scale: [c3Scale.x, c3Scale.y, c3Scale.z],
        });
      }
      const fPos = floorGroup.position;
      const fQuat = floorGroup.quaternion;
      const fScale = floorGroup.scale;
      if (fPos && fQuat && fScale) {
        manifestDraft.updateFloorTransform({
          pos: [fPos.x, fPos.y, fPos.z],
          rot: [fQuat.x, fQuat.y, fQuat.z, fQuat.w],
          scale: [fScale.x, fScale.y, fScale.z],
        });
      }
      const cPos = ceilingGroup.position;
      const cQuat = ceilingGroup.quaternion;
      const cScale = ceilingGroup.scale;
      if (cPos && cQuat && cScale) {
        manifestDraft.updateCeilingTransform({
          pos: [cPos.x, cPos.y, cPos.z],
          rot: [cQuat.x, cQuat.y, cQuat.z, cQuat.w],
          scale: [cScale.x, cScale.y, cScale.z],
        });
      }
      const nextModelId = merged.some((m) => m.id === manifestDraft.manifest.defaults.modelId)
        ? manifestDraft.manifest.defaults.modelId
        : merged[0]?.id ?? "";
      const defaultModel = merged.find((m) => m.id === nextModelId);
      const prevAccessoryId = manifestDraft.manifest.defaults.accessoryId;
      const nextAccessoryId =
        prevAccessoryId && defaultModel?.accessories.some((a) => a.id === prevAccessoryId)
          ? prevAccessoryId
          : undefined;
      const mergedManifest: SceneManifest = {
        ...manifestDraft.manifest,
        models: merged,
        defaults: {
          ...manifestDraft.manifest.defaults,
          modelId: nextModelId,
          ...(nextAccessoryId !== undefined
            ? { accessoryId: nextAccessoryId }
            : {}),
        },
      };
      if (nextAccessoryId === undefined) {
        delete mergedManifest.defaults.accessoryId;
      }
      const result = validateForExport(mergedManifest);
      if (!result.success && result.errors) {
        alert("Validation failed:\n" + result.errors.join("\n"));
        return;
      }
      const mergedBody = JSON.stringify(mergedManifest);
      const saveRes = await fetch(
        MANIFEST_SAVE_URL,
        manifestAuthFetchInit({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: mergedBody,
        })
      );
      const data = (await saveRes.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        if (remoteManifestApi) {
          try { await fetch(LOCAL_SAVE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: mergedBody }); } catch { /* ok */ }
        }
        location.reload();
      } else {
        alert("Save failed: " + (data.error ?? saveRes.status));
      }
    } catch (err) {
      alert("Rescan failed: " + (err instanceof Error ? err.message : String(err)));
    }
  });
  rightPanel.appendChild(rescanSplatsBtn);

  async function persistManifestToProject(): Promise<{ ok: boolean; error?: string }> {
    const pos = dealershipGroup.position;
    const quat = dealershipGroup.quaternion;
    const scale = dealershipGroup.scale;
    if (pos && quat && scale) {
      manifestDraft.updateDealershipTransform({
        pos: [pos.x, pos.y, pos.z],
        rot: [quat.x, quat.y, quat.z, quat.w],
        scale: [scale.x, scale.y, scale.z],
      });
    }
    const bPos = blackdropGroup.position;
    const bQuat = blackdropGroup.quaternion;
    const bScale = blackdropGroup.scale;
    if (bPos && bQuat && bScale) {
      manifestDraft.updateBlackdropTransform({
        pos: [bPos.x, bPos.y, bPos.z],
        rot: [bQuat.x, bQuat.y, bQuat.z, bQuat.w],
        scale: [bScale.x, bScale.y, bScale.z],
      });
    }
    const c3Pos = changan3dGroup.position;
    const c3Quat = changan3dGroup.quaternion;
    const c3Scale = changan3dGroup.scale;
    if (c3Pos && c3Quat && c3Scale) {
      manifestDraft.updateChangan3DTransform({
        pos: [c3Pos.x, c3Pos.y, c3Pos.z],
        rot: [c3Quat.x, c3Quat.y, c3Quat.z, c3Quat.w],
        scale: [c3Scale.x, c3Scale.y, c3Scale.z],
      });
    }
    const fPos = floorGroup.position;
    const fQuat = floorGroup.quaternion;
    const fScale = floorGroup.scale;
    if (fPos && fQuat && fScale) {
      manifestDraft.updateFloorTransform({
        pos: [fPos.x, fPos.y, fPos.z],
        rot: [fQuat.x, fQuat.y, fQuat.z, fQuat.w],
        scale: [fScale.x, fScale.y, fScale.z],
      });
    }
    const cPos = ceilingGroup.position;
    const cQuat = ceilingGroup.quaternion;
    const cScale = ceilingGroup.scale;
    if (cPos && cQuat && cScale) {
      manifestDraft.updateCeilingTransform({
        pos: [cPos.x, cPos.y, cPos.z],
        rot: [cQuat.x, cQuat.y, cQuat.z, cQuat.w],
        scale: [cScale.x, cScale.y, cScale.z],
      });
    }
    const result = validateForExport(manifestDraft.manifest);
    if (!result.success && result.errors) {
      return { ok: false, error: result.errors.join("\n") };
    }
    try {
      const body = JSON.stringify(manifestDraft.manifest);
      const res = await fetch(
        MANIFEST_SAVE_URL,
        manifestAuthFetchInit({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      );
      const data = (await res.json()) as { ok?: boolean; error?: string; modelCount?: number; hasDealership?: boolean };
      if (!data.ok) {
        return { ok: false, error: data.error ?? String(res.status) };
      }
      console.log(`[editor] Save OK: ${data.modelCount} models, dealership=${data.hasDealership}`);
      if (remoteManifestApi) {
        try {
          await fetch(LOCAL_SAVE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          console.log("[editor] Local manifest.json also updated");
        } catch {
          console.warn("[editor] Local save skipped (dev server not running or endpoint unavailable)");
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Save to project (writes manifest.json with transforms – persists beyond browser cache)
  const saveToProjectBtn = document.createElement("button");
  saveToProjectBtn.textContent = "Save to project";
  saveToProjectBtn.title = "Save transforms to public/manifest.json (persists across sessions, survives cache clear)";
  saveToProjectBtn.addEventListener("click", async () => {
    const r = await persistManifestToProject();
    if (r.ok) {
      saveToProjectBtn.textContent = "Saved ✓";
      setTimeout(() => {
        saveToProjectBtn.textContent = "Save to project";
      }, 2000);
    } else {
      alert("Save failed: " + (r.error ?? "unknown"));
    }
  });
  rightPanel.appendChild(saveToProjectBtn);

  if (import.meta.env.DEV) {
    const publishSection = document.createElement("div");
    publishSection.className = "editor-publish-section";
    const publishTitle = document.createElement("div");
    publishTitle.className = "editor-publish-title";
    publishTitle.textContent = "Publish";
    const publishHint = document.createElement("div");
    publishHint.className = "editor-publish-hint";
    publishHint.textContent =
      "Runs on your machine via the Vite dev server (wrangler + git). Requires CLI auth. Saves manifest first.";
    publishSection.appendChild(publishTitle);
    publishSection.appendChild(publishHint);

    async function runDevDeploy(
      path: "/__deploy/cloudflare" | "/__deploy/github"
    ): Promise<{
      ok?: boolean;
      error?: string;
      stdout?: string;
      stderr?: string;
      noChanges?: boolean;
    }> {
      const headers: Record<string, string> = {};
      const sec = import.meta.env.VITE_EDITOR_DEPLOY_SECRET;
      if (sec) headers["X-Editor-Deploy-Secret"] = sec;
      const r = await fetch(path, { method: "POST", headers });
      const data = (await r.json()) as {
        ok?: boolean;
        error?: string;
        stdout?: string;
        stderr?: string;
        noChanges?: boolean;
      };
      if (data.stdout) console.log(`[deploy ${path}]`, data.stdout);
      if (data.stderr) console.warn(`[deploy ${path}] stderr`, data.stderr);
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}${data.stderr ? "\n" + data.stderr : ""}`);
      }
      return data;
    }

    function attachPublishProgress(btn: HTMLButtonElement, idleLabel: string) {
      const spinner = document.createElement("span");
      spinner.className = "editor-publish-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const caption = document.createElement("span");
      caption.className = "editor-publish-btn-caption";
      caption.textContent = idleLabel;
      btn.replaceChildren(spinner, caption);
      return {
        setIdle() {
          btn.classList.remove("editor-publish-btn--busy");
          btn.removeAttribute("aria-busy");
          spinner.classList.remove("editor-publish-spinner--visible");
          caption.textContent = idleLabel;
        },
        setBusy(message: string) {
          btn.classList.add("editor-publish-btn--busy");
          btn.setAttribute("aria-busy", "true");
          spinner.classList.add("editor-publish-spinner--visible");
          caption.textContent = message;
        },
      };
    }

    /** Latest editor app on Pages for branch `main` (production *.pages.dev or branch alias). */
    const editorPagesMainUrl = (
      import.meta.env.VITE_CF_PAGES_EDITOR_MAIN_URL as string | undefined
    )?.trim() ||
      "https://spark-viewer-editor.pages.dev";

    const deployCfBtn = document.createElement("button");
    deployCfBtn.type = "button";
    deployCfBtn.className = "editor-publish-btn editor-publish-btn--cloudflare editor-publish-btn--grow";
    deployCfBtn.title = "Save manifest, then pnpm pages:deploy (viewer + editor)";
    const deployCfProgress = attachPublishProgress(deployCfBtn, "Deploy to Cloudflare");

    const openCfMainPreviewBtn = document.createElement("button");
    openCfMainPreviewBtn.type = "button";
    openCfMainPreviewBtn.className =
      "editor-publish-btn editor-publish-btn--cloudflare editor-publish-btn--icon-only";
    openCfMainPreviewBtn.title = `Open latest main deployment in a new tab (${editorPagesMainUrl})`;
    openCfMainPreviewBtn.setAttribute("aria-label", "Open latest main Pages preview");
    const openIcon = document.createElement("span");
    openIcon.className = "editor-publish-open-icon";
    openIcon.setAttribute("aria-hidden", "true");
    openIcon.textContent = "↗";
    openCfMainPreviewBtn.appendChild(openIcon);
    openCfMainPreviewBtn.addEventListener("click", () => {
      try {
        const u = new URL(editorPagesMainUrl);
        window.open(u.href, "_blank", "noopener,noreferrer");
      } catch {
        window.open(editorPagesMainUrl, "_blank", "noopener,noreferrer");
      }
    });

    const deployCfRow = document.createElement("div");
    deployCfRow.className = "editor-publish-row";
    deployCfRow.appendChild(deployCfBtn);
    deployCfRow.appendChild(openCfMainPreviewBtn);

    const pushGhBtn = document.createElement("button");
    pushGhBtn.type = "button";
    pushGhBtn.className = "editor-publish-btn editor-publish-btn--github";
    pushGhBtn.title = "Save manifest, then git add / commit / push (scripts/editor-git-push.sh)";
    const pushGhProgress = attachPublishProgress(pushGhBtn, "Push to GitHub");

    let publishInFlight = false;

    deployCfBtn.addEventListener("click", async () => {
      if (publishInFlight) return;
      publishInFlight = true;
      deployCfBtn.disabled = true;
      openCfMainPreviewBtn.disabled = true;
      pushGhBtn.disabled = true;
      deployCfProgress.setBusy("Saving manifest…");
      try {
        const saved = await persistManifestToProject();
        if (!saved.ok) {
          alert("Save manifest first failed: " + saved.error);
          return;
        }
        deployCfProgress.setBusy("Deploying to Cloudflare…");
        await runDevDeploy("/__deploy/cloudflare");
        alert("Cloudflare deploy finished. Check the terminal running Vite for wrangler output.");
      } catch (e) {
        alert("Cloudflare deploy failed:\n" + (e instanceof Error ? e.message : String(e)));
      } finally {
        publishInFlight = false;
        deployCfProgress.setIdle();
        pushGhProgress.setIdle();
        deployCfBtn.disabled = false;
        openCfMainPreviewBtn.disabled = false;
        pushGhBtn.disabled = false;
      }
    });
    publishSection.appendChild(deployCfRow);

    pushGhBtn.addEventListener("click", async () => {
      if (publishInFlight) return;
      publishInFlight = true;
      deployCfBtn.disabled = true;
      openCfMainPreviewBtn.disabled = true;
      pushGhBtn.disabled = true;
      pushGhProgress.setBusy("Saving manifest…");
      try {
        const saved = await persistManifestToProject();
        if (!saved.ok) {
          alert("Save manifest first failed: " + saved.error);
          return;
        }
        pushGhProgress.setBusy("Pushing to GitHub…");
        const data = await runDevDeploy("/__deploy/github");
        if (data.noChanges) {
          alert("Nothing new to commit (working tree was already clean after save).");
        } else {
          alert("Git push completed. Check console for details.");
        }
      } catch (e) {
        alert("GitHub push failed:\n" + (e instanceof Error ? e.message : String(e)));
      } finally {
        publishInFlight = false;
        deployCfProgress.setIdle();
        pushGhProgress.setIdle();
        deployCfBtn.disabled = false;
        openCfMainPreviewBtn.disabled = false;
        pushGhBtn.disabled = false;
      }
    });
    publishSection.appendChild(pushGhBtn);

    rightPanel.appendChild(publishSection);
  }

  // Export button (download as file)
  const exportBtn = document.createElement("button");
  exportBtn.textContent = "Export manifest";
  exportBtn.title = "Download manifest.json to your computer";
  exportBtn.addEventListener("click", () => {
    const result = downloadManifest(manifestDraft.manifest);
    if (!result.success && result.errors) {
      alert("Validation failed:\n" + result.errors.join("\n"));
    }
  });
  rightPanel.appendChild(exportBtn);

  const resetModelBtn = document.createElement("button");
  resetModelBtn.textContent = "Reset Model";
  resetModelBtn.title = "Reset current asset transform (position, rotation, scale, pivot) to default";
  resetModelBtn.addEventListener("click", () => {
    const identity = editorRuntime.resetCurrentTransform();
    if (identity && transformGroupRef && meshRef) {
      transformGroupRef.position.set(identity.pos[0], identity.pos[1], identity.pos[2]);
      transformGroupRef.quaternion.set(
        identity.rot[0],
        identity.rot[1],
        identity.rot[2],
        identity.rot[3]
      );
      const [sx, sy, sz] = getScale(identity);
      transformGroupRef.scale.set(sx, sy, sz);
      // Re-anchor the gizmo at the splat's center of mass after the reset.
      const def = editorRuntime.getActiveAssetDef();
      if (def && transformGroupRef && autoCenterPivot(def, { group: transformGroupRef, mesh: meshRef.mesh })) {
        manifestDraft.patchManifest(() => {});
      }
      const applied = def?.transform ?? identity;
      transformGizmos.setTransform(applied);
      transformGizmos.applyPivotToMesh(meshRef.mesh, getPivot(applied), getPivotRot(applied));
      transformParamsPanel.refresh();
    }
  });
  rightPanel.appendChild(resetModelBtn);

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset to file";
  resetBtn.title = "Clear saved changes and reload from file";
  resetBtn.addEventListener("click", async () => {
    if (!confirm("Discard all saved edits and reload from file?")) return;
    localStorage.removeItem(MANIFEST_STORAGE_KEY);
    location.reload();
  });
  rightPanel.appendChild(resetBtn);

  function applyManifestToScene(m: SceneManifest): void {
    const { modelId } = editorRuntime.state;
    const model = m.models.find((mo) => mo.id === modelId);
    if (!model) return;
    const layers = getAssetLayers(modelId);
    for (const layer of layers) {
      const def = resolveLayerDef(model, layer);
      if (!def) continue;
      const ref = assetRefs[layer.url];
      if (!ref) continue;
      const t = def.transform;
      ref.group.position.set(t.pos[0], t.pos[1], t.pos[2]);
      ref.group.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
      const [sx, sy, sz] = getScale(t);
      ref.group.scale.set(sx, sy, sz);
      const pivot = getPivot(t);
      const pivotRot = getPivotRot(t);
      ref.mesh.position.set(-pivot[0], -pivot[1], -pivot[2]);
      ref.mesh.quaternion.set(pivotRot[0], pivotRot[1], pivotRot[2], pivotRot[3]);
    }
    const { activeLayer: activeLayerRef } = editorRuntime.state;
    const activeLayer = layers.find(
      (l) =>
        !l.isNameplate3d &&
        !l.isContactShadow &&
        l.kind === activeLayerRef.kind &&
        (l.kind !== "accessory" || l.accessoryId === activeLayerRef.accessoryId)
    );
    const activeRef = activeLayer ? assetRefs[activeLayer.url] : null;
    if (activeRef) {
      const activeDef = editorRuntime.getActiveAssetDef()!;
      transformGizmos.setTransform(activeDef.transform);
      transformGizmos.applyPivotToMesh(activeRef.mesh, getPivot(activeDef.transform), getPivotRot(activeDef.transform));
    }
    const ft = m.floor?.transform ?? DEFAULT_FLOOR_TRANSFORM;
    floorGroup.position.set(ft.pos[0], ft.pos[1], ft.pos[2]);
    floorGroup.quaternion.set(ft.rot[0], ft.rot[1], ft.rot[2], ft.rot[3]);
    const [fsx, fsy, fsz] = getScale(ft);
    floorGroup.scale.set(fsx, fsy, fsz);
    applyFloorBrightness(floorGroup, m.floor?.brightness);
    syncFloorBrightnessInput();
    const ct = m.ceiling?.transform ?? DEFAULT_CEILING_TRANSFORM;
    ceilingGroup.position.set(ct.pos[0], ct.pos[1], ct.pos[2]);
    ceilingGroup.quaternion.set(ct.rot[0], ct.rot[1], ct.rot[2], ct.rot[3]);
    const [csx, csy, csz] = getScale(ct);
    ceilingGroup.scale.set(csx, csy, csz);
    applyCeilingBrightness(ceilingGroup, m.ceiling?.brightness);
    syncCeilingBrightnessInput();
    transformParamsPanel.refresh();
  }

  window.addEventListener("keydown", (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    if (e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      const restored = undoRedo.undo();
      if (restored) {
        editorRuntime.restoreManifest(restored);
        manifestDraft.restoreManifest(restored);
        applyManifestToScene(restored);
      }
    } else if (e.key === "z" && e.shiftKey) {
      e.preventDefault();
      const restored = undoRedo.redo();
      if (restored) {
        editorRuntime.restoreManifest(restored);
        manifestDraft.restoreManifest(restored);
        applyManifestToScene(restored);
      }
    }
  });

  function showLoadErrorToast(layerLabel: string, message: string): void {
    const toast = document.createElement("div");
    toast.className = "editor-load-error-toast";
    toast.textContent = `Failed to load ${layerLabel}: ${message}`;
    toast.style.cssText =
      "position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);max-width:90%;padding:0.6rem 1rem;background:#c22;color:#fff;border-radius:6px;font-size:0.85rem;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.4);";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 8000);
  }

  function inferFileTypeFromUrl(url: string): SplatFileType | undefined {
    const ext = url.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, SplatFileType> = {
      sog: SplatFileType.PCSOGSZIP,
      sag: SplatFileType.PCSOGSZIP,
      ozg: SplatFileType.PCSOGSZIP,
      zip: SplatFileType.PCSOGSZIP,
      sogs: SplatFileType.PCSOGS,
      ply: SplatFileType.PLY,
      spz: SplatFileType.SPZ,
      splat: SplatFileType.SPLAT,
      ksplat: SplatFileType.KSPLAT,
      ksg: SplatFileType.KSPLAT,
    };
    return map[ext];
  }

  /** Mean of splat centers in mesh-local space. */
  function computeSplatCenterOfMass(
    mesh: import("@sparkjsdev/spark").SplatMesh
  ): [number, number, number] | null {
    const packed = mesh.packedSplats;
    if (!packed) return null;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    packed.forEachSplat((_i, center) => {
      sx += center.x;
      sy += center.y;
      sz += center.z;
      n++;
    });
    if (n === 0) return null;
    return [sx / n, sy / n, sz / n];
  }

  /**
   * Splat scans rarely center their content at the local origin, which leaves the
   * gizmo floating off to one side. When a layer has no meaningful stored pivot,
   * anchor it at the splat's center of mass, shifting `pos` so the model stays put
   * on screen. Returns true when the transform was modified.
   */
  function autoCenterPivot(
    def: AssetDef,
    ref: { group: THREE.Group; mesh: import("@sparkjsdev/spark").SplatMesh }
  ): boolean {
    const t = def.transform;
    const p = t.pivot;
    if (p && (p[0] !== 0 || p[1] !== 0 || p[2] !== 0)) return false;
    const center = computeSplatCenterOfMass(ref.mesh);
    if (!center) return false;
    const [cx, cy, cz] = center;
    if (cx === 0 && cy === 0 && cz === 0) return false;
    const [sx, sy, sz] = getScale(t);
    // world = pos + R·(S∘(pivotRot·x − pivot)); compensate pos for the new pivot.
    const delta = new THREE.Vector3(cx * sx, cy * sy, cz * sz).applyQuaternion(
      new THREE.Quaternion(t.rot[0], t.rot[1], t.rot[2], t.rot[3])
    );
    t.pivot = [cx, cy, cz];
    t.pos = [t.pos[0] + delta.x, t.pos[1] + delta.y, t.pos[2] + delta.z];
    ref.group.position.set(t.pos[0], t.pos[1], t.pos[2]);
    ref.mesh.position.set(-cx, -cy, -cz);
    return true;
  }

  /** Bumped by every loadAllAssets call; in-flight loads from an older call are discarded. */
  let assetLoadGeneration = 0;

  async function loadOneAsset(
    assetDef: AssetDef,
    layerLabel: string,
    container: THREE.Group,
    isStale: () => boolean = () => false
  ): Promise<{ group: THREE.Group; mesh: import("@sparkjsdev/spark").SplatMesh } | null> {
    try {
      const fileTypeMap: Record<string, SplatFileType> = {
        zip: SplatFileType.PCSOGSZIP,
        ply: SplatFileType.PLY,
        spz: SplatFileType.SPZ,
        splat: SplatFileType.SPLAT,
        ksplat: SplatFileType.KSPLAT,
        sogs: SplatFileType.PCSOGS,
      };
      let fileType = assetDef.fileType ? fileTypeMap[assetDef.fileType] : undefined;
      if (!fileType) fileType = inferFileTypeFromUrl(assetDef.url);
      if (!fileType && /\.(sog|sag|ozg|zip)$/i.test(assetDef.url.split("?")[0])) {
        fileType = SplatFileType.PCSOGSZIP;
      }
      const fetchUrl = resolveSplatAssetUrl(assetDef.url);
      const res = await fetch(fetchUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch: ${res.status} ${fetchUrl}`);
      }
      const bytes = await res.arrayBuffer();
      if (isStale()) return null;
      const mesh = await runtime.loadSplatFromBytes(bytes, undefined, fileType);
      container.remove(mesh);
      if (isStale()) {
        mesh.dispose();
        return null;
      }

      const t = assetDef.transform;
      const pivot = getPivot(t);
      const pivotRot = getPivotRot(t);

      const transformGroup = new THREE.Group();
      transformGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
      transformGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
      const [sx, sy, sz] = getScale(t);
      transformGroup.scale.set(sx, sy, sz);

      mesh.position.set(-pivot[0], -pivot[1], -pivot[2]);
      mesh.quaternion.set(pivotRot[0], pivotRot[1], pivotRot[2], pivotRot[3]);
      mesh.scale.setScalar(1);
      transformGroup.add(mesh);
      container.add(transformGroup);

      return { group: transformGroup, mesh };
    } catch (err) {
      console.error(`Failed to load ${layerLabel}:`, err);
      const msg = err instanceof Error ? err.message : String(err);
      showLoadErrorToast(layerLabel, msg);
      return null;
    }
  }

  async function loadDealership(): Promise<void> {
    try {
      const res = await fetch(DEALERSHIP_URL);
      if (!res.ok) return;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mesh = new SplatMesh({
        fileBytes: bytes,
        fileType: SplatFileType.PCSOGSZIP,
      });
      await mesh.initialized;
      dealershipGroup.add(mesh);
      applyDealershipTransform(getDealershipTransform());
      dealershipGroup.visible = dealershipVisible;
      runtime.getSplatContainer().add(dealershipGroup);
    } catch {
      /* ignore */
    }
  }

  async function loadFloor(): Promise<void> {
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(FLOOR_URL);
      while (floorGroup.children.length > 0) {
        floorGroup.remove(floorGroup.children[0]!);
      }
      floorGroup.add(gltf.scene);
      floorGroup.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.renderOrder = -40;
        }
      });
      applyFloorTransform(getFloorTransform());
      floorGroup.visible = dealershipVisible;
      runtime.getSplatContainer().add(floorGroup);
      reapplySceneAppearance();
    } catch {
      /* ignore missing or invalid GLB */
    }
  }

  async function loadCeiling(): Promise<void> {
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(CEILING_URL);
      while (ceilingGroup.children.length > 0) {
        ceilingGroup.remove(ceilingGroup.children[0]!);
      }
      ceilingGroup.add(gltf.scene);
      ceilingGroup.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.renderOrder = -35;
        }
      });
      applyCeilingTransform(getCeilingTransform());
      ceilingGroup.visible = dealershipVisible;
      runtime.getSplatContainer().add(ceilingGroup);
      reapplySceneAppearance();
    } catch {
      /* ignore missing or invalid GLB */
    }
  }

  async function loadBlackdrop(): Promise<void> {
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(BLACKDROP_URL);
      while (blackdropGroup.children.length > 0) {
        blackdropGroup.remove(blackdropGroup.children[0]!);
      }
      blackdropGroup.add(gltf.scene);
      applyBlackdropTransform(getBlackdropTransform());
      blackdropGroup.visible = blackdropVisible;
      runtime.getSplatContainer().add(blackdropGroup);
      reapplySceneAppearance();
    } catch {
      /* ignore missing or invalid GLB */
    }
  }

  async function loadChangan3D(): Promise<void> {
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(CHANGAN3D_URL);
      while (changan3dGroup.children.length > 0) {
        changan3dGroup.remove(changan3dGroup.children[0]!);
      }
      changan3dGroup.add(gltf.scene);
      changan3dGroup.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.renderOrder = 2;
        }
      });
      applyChangan3DTransform(getChangan3DTransform());
      changan3dGroup.visible = blackdropVisible;
      applyChangan3DTint(changan3dGroup, manifestDraft.manifest.changan3D?.tint);
      void applyNameplateMatcapFromOptions(
        changan3dGroup,
        manifestDraft.manifest.scene?.nameplateMatcap
      );
      runtime.getSplatContainer().add(changan3dGroup);
      // Now that base colors are cached, seed the color picker to the effective
      // (15%-lighter) default if no explicit tint has been set yet.
      sceneAppearancePanel.refresh();
    } catch {
      /* ignore missing or invalid GLB */
    }
  }

  async function loadPanoBackground(): Promise<void> {
    const def = manifestDraft.manifest.panoBackground;
    const url = resolveSplatAssetUrl(def?.url ?? DEFAULT_PANO_URL);
    if (url === panoLoadedUrl && panoGroup.children.length > 0) {
      applyPanoTransform(getPanoTransform());
      return;
    }
    try {
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;

      while (panoGroup.children.length > 0) {
        panoGroup.remove(panoGroup.children[0]!);
      }
      const brightness = def?.brightness ?? 1;
      const geom = new THREE.SphereGeometry(1, 64, 32);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        side: THREE.BackSide,
        depthWrite: false,
        color: new THREE.Color(brightness, brightness, brightness),
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = -100;
      mesh.frustumCulled = false;
      panoGroup.add(mesh);
      panoLoadedUrl = url;

      applyPanoTransform(getPanoTransform());
      // Pano follows the dealership layer's visibility convention.
      panoGroup.visible = dealershipVisible;
      if (!panoGroup.parent) runtime.getSplatContainer().add(panoGroup);
    } catch {
      /* ignore missing image */
    }
  }

  async function loadAllAssets(preferredLayer?: AssetLayerInfo): Promise<void> {
    editingDealership = false;
    editingFloor = false;
    editingCeiling = false;
    editingBlackdrop = false;
    editingChangan3D = false;
    editingPano = false;
    editingNameplate3d = false;
    editingContactShadow = false;
    updateEditDealershipBtnLabel();
    updateEditFloorBtnLabel();
    updateEditCeilingBtnLabel();
    updateEditBlackdropBtnLabel();
    updateEditChangan3dBtnLabel();
    updateEditPanoBtnLabel();
    const container = runtime.getSplatContainer();
    const toRemove = container.children.filter(
      (c) =>
        !(c as THREE.Object3D).userData?.isDealership &&
        !(c as THREE.Object3D).userData?.isFloor &&
        !(c as THREE.Object3D).userData?.isCeiling &&
        !(c as THREE.Object3D).userData?.isBlackdrop &&
        !(c as THREE.Object3D).userData?.isChangan3D &&
        !(c as THREE.Object3D).userData?.isPanoBackground &&
        !(c as THREE.Object3D).userData?.isNameplate3d &&
        !(c as THREE.Object3D).userData?.isContactShadow
    );
    for (const child of toRemove) {
      if ("dispose" in child && typeof (child as { dispose: () => void }).dispose === "function") {
        (child as { dispose: () => void }).dispose();
      }
      container.remove(child);
    }
    transformGizmos.setTarget(null);
    editorRuntime.setActiveMesh(null);
    transformGroupRef = null;
    meshRef = null;
    for (const k of Object.keys(assetRefs)) delete assetRefs[k];
    colorRangePanel.clearSelection();

    const generation = ++assetLoadGeneration;
    const isStale = () => generation !== assetLoadGeneration;

    const { modelId } = editorRuntime.state;
    const model = manifestDraft.manifest.models.find((m) => m.id === modelId);
    if (!model) return;

    const layers = getAssetLayers(modelId);
    const loadLayers = layers.filter((l) => !l.isNameplate3d && !l.isContactShadow);
    const settled = await Promise.allSettled(
      loadLayers.map(async (layer) => {
        const def = resolveLayerDef(model, layer);
        if (!def) return { layer, ref: null };
        const ref = await loadOneAsset(def, layer.label, container, isStale);
        return { layer, ref };
      })
    );
    // A newer loadAllAssets (e.g. the user switched model again) owns the scene now.
    if (isStale()) return;

    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.ref) {
        assetRefs[s.value.layer.url] = s.value.ref;
      }
    }

    // Anchor the gizmo at each splat's center of mass the first time it loads
    // without a stored pivot (keeps the model visually in place).
    let pivotsChanged = false;
    for (const layer of loadLayers) {
      const ref = assetRefs[layer.url];
      const def = resolveLayerDef(model, layer);
      if (ref && def && autoCenterPivot(def, ref)) pivotsChanged = true;
    }
    if (pivotsChanged) manifestDraft.patchManifest(() => {});

    for (const layer of layers) {
      const ref = assetRefs[layer.url];
      if (ref) {
        ref.group.visible = assetsLayerPanel.getVisibility(modelId, layer);
      }
    }

    await loadNameplate3dForModel(modelId);
    if (isStale()) return;
    syncLayerVisibilityFromPanel(modelId);

    const preferContactShadow =
      preferredLayer?.isContactShadow === true &&
      assetsLayerPanel.getVisibility(modelId, preferredLayer);

    const preferNameplate3d =
      preferredLayer?.isNameplate3d === true &&
      assetsLayerPanel.getVisibility(modelId, preferredLayer) &&
      nameplateGroup.children.length > 0;

    const firstVisible: AssetLayerInfo | null = preferContactShadow
      ? preferredLayer!
      : preferNameplate3d
      ? preferredLayer!
      : preferredLayer &&
          !preferredLayer.isNameplate3d &&
          !preferredLayer.isContactShadow &&
          assetRefs[preferredLayer.url] &&
          assetsLayerPanel.getVisibility(modelId, preferredLayer)
        ? preferredLayer
        : layers.find(
            (l) =>
              !l.isNameplate3d &&
              !l.isContactShadow &&
              assetsLayerPanel.getVisibility(modelId, l) &&
              assetRefs[l.url]
          ) ??
          layers.find((l) => !l.isNameplate3d && !l.isContactShadow) ??
          null;

    if (firstVisible?.isContactShadow) {
      editingContactShadow = true;
      editingNameplate3d = false;
      transformGroupRef = contactShadowGroup;
      meshRef = null;
      editorRuntime.setActiveMesh(null);
      editorRuntime.setActiveLayer({ kind: "base" });
      assetsLayerPanel.setActive(modelId, firstVisible);
      const t = getContactShadowTransform();
      transformGizmos.setTransform(t);
      applyContactShadowFromManifest(modelId);
    } else if (firstVisible?.isNameplate3d) {
      editingNameplate3d = true;
      editingContactShadow = false;
      transformGroupRef = nameplateGroup;
      meshRef = null;
      editorRuntime.setActiveMesh(null);
      editorRuntime.setActiveLayer({ kind: "base" });
      assetsLayerPanel.setActive(modelId, firstVisible);
      const t = getNameplate3dTransform();
      transformGizmos.setTransform(t);
      applyNameplate3dTransform(t);
    } else if (firstVisible) {
      editingContactShadow = false;
      editingNameplate3d = false;
      editorRuntime.setActiveLayer(layerToRef(firstVisible));
      assetsLayerPanel.setActive(modelId, firstVisible);
      const activeRef = assetRefs[firstVisible.url];
      if (activeRef) {
        transformGroupRef = activeRef.group;
        meshRef = { mesh: activeRef.mesh };
        editorRuntime.setActiveMesh(activeRef.mesh);
      }
    } else {
      editingContactShadow = false;
      editingNameplate3d = false;
    }

    transformGizmos.onTransformChange((transform) => {
      if (editingChangan3D) {
        const t: TransformDef = {
          pos: transform.pos,
          rot: transform.rot,
          scale: transform.scale,
        };
        manifestDraft.updateChangan3DTransform(t);
        applyChangan3DTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingBlackdrop) {
        const t: TransformDef = {
          pos: transform.pos,
          rot: transform.rot,
          scale: transform.scale,
        };
        manifestDraft.updateBlackdropTransform(t);
        applyBlackdropTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingDealership) {
        const t: TransformDef = {
          pos: transform.pos,
          rot: transform.rot,
          scale: transform.scale,
        };
        manifestDraft.updateDealershipTransform(t);
        applyDealershipTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingPano) {
        // Force uniform scale: the TransformControls scale gizmo has per-axis
        // handles, but the pano sphere should always grow/shrink symmetrically.
        // Pick the axis whose value diverged furthest from the last uniform
        // value — that's the one the user is dragging.
        const sx = Array.isArray(transform.scale) ? transform.scale[0] : transform.scale;
        const sy = Array.isArray(transform.scale) ? transform.scale[1] : transform.scale;
        const sz = Array.isArray(transform.scale) ? transform.scale[2] : transform.scale;
        const dx = Math.abs(sx - lastPanoUniformScale);
        const dy = Math.abs(sy - lastPanoUniformScale);
        const dz = Math.abs(sz - lastPanoUniformScale);
        const uniform = dx >= dy && dx >= dz ? sx : dy >= dz ? sy : sz;
        lastPanoUniformScale = uniform;
        const t: TransformDef = {
          pos: transform.pos,
          rot: transform.rot,
          scale: [uniform, uniform, uniform],
        };
        manifestDraft.updatePanoBackgroundTransform(t);
        applyPanoTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingFloor) {
        const t: TransformDef = {
          pos: transform.pos,
          rot: transform.rot,
          scale: transform.scale,
        };
        manifestDraft.updateFloorTransform(t);
        applyFloorTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingCeiling) {
        const t: TransformDef = {
          pos: transform.pos,
          rot: transform.rot,
          scale: transform.scale,
        };
        manifestDraft.updateCeilingTransform(t);
        applyCeilingTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (editingContactShadow) {
        const t: TransformDef = {
          pos: transform.pos,
          rot: transform.rot,
          scale: transform.scale,
        };
        manifestDraft.updateContactShadowTransform(editorRuntime.state.modelId, t);
        applyContactShadowFromManifest(editorRuntime.state.modelId);
        transformParamsPanel.refresh();
        return;
      }
      if (editingNameplate3d) {
        const t: TransformDef = {
          pos: transform.pos,
          rot: transform.rot,
          scale: transform.scale,
        };
        manifestDraft.updateNameplate3dTransform(editorRuntime.state.modelId, t);
        applyNameplate3dTransform(t);
        transformParamsPanel.refresh();
        return;
      }
      if (isEditingBookmarkPivot && selectedBookmarkIdRef) {
        editorRuntime.updateCameraBookmark(selectedBookmarkIdRef, {
          target: [transform.pos[0], transform.pos[1], transform.pos[2]],
        });
        const bmk = editorRuntime.getCameraBookmark(selectedBookmarkIdRef);
        if (
          bmk?.cameraMode === "freelook" &&
          bookmarkViewportStage === "live" &&
          freeLook.enabled
        ) {
          freeLook.setFromBookmark(bmk.pos, [
            transform.pos[0],
            transform.pos[1],
            transform.pos[2],
          ]);
        } else {
          runtime.controls.target.set(transform.pos[0], transform.pos[1], transform.pos[2]);
        }
        cameraBookmarksPanel.refresh();
        bookmarkNavigator.refresh();
        return;
      }
      const isPivot = currentGizmoMode === "pivotTranslate" || currentGizmoMode === "pivotRotate";
      const asset = editorRuntime.getActiveAssetDef();
      if (isPivot && asset) {
        editorRuntime.updatePivot(
          [-transform.pos[0], -transform.pos[1], -transform.pos[2]],
          transform.rot
        );
      } else if (asset) {
        editorRuntime.updateTransform({
          ...asset.transform,
          pos: transform.pos,
          rot: transform.rot,
          scale: transform.scale,
        });
      }
      transformParamsPanel.refresh();
    });

    applyGizmoTargetAndMode();
    if (editingContactShadow) {
      transformGizmos.setTransform(getContactShadowTransform());
    } else if (editingNameplate3d) {
      transformGizmos.setTransform(getNameplate3dTransform());
    } else {
      const activeAssetDef = editorRuntime.getActiveAssetDef();
      if (activeAssetDef && transformGroupRef && meshRef) {
        transformGizmos.setTransform(activeAssetDef.transform);
        transformGizmos.applyPivotToMesh(
          meshRef.mesh,
          getPivot(activeAssetDef.transform),
          getPivotRot(activeAssetDef.transform)
        );
      }
    }
    transformParamsPanel.refresh();
    currentBookmarkIndex = 0;
    selectedBookmarkIdRef = null;
    isEditingBookmarkPivot = false;
    pivotProxy.visible = false;
    cameraBookmarksPanel.setSelectedBookmarkId(null);
    cameraBookmarksPanel.refresh();
    bookmarkNavigator.refresh();
    assetsLayerPanel.refresh();
    syncLayerVisibilityFromPanel(modelId);

    // Frame the camera on the model so it's visible
    const namedBm = model.cameraBookmarks?.[0];
    const legBm = model.bookmarks?.exterior;
    if (namedBm) {
      bookmarkViewportStage = "edit";
      applyCameraViewport(namedBm, "edit");
      startBookmarkCameraTravel(namedBm);
    } else if (legBm && "pos" in legBm && "target" in legBm) {
      cameraTravel.start({ pos: legBm.pos, target: legBm.target });
    }
  }

  // Load all assets (a model always opens with only its base splat visible)
  assetsLayerPanel.resetToBaseOnly(editorRuntime.state.modelId);
  await loadAllAssets();
  if (!backdropOnly) {
    dealershipEnvRequested = true;
    void loadDealership();
    void loadFloor();
    void loadCeiling();
    void loadPanoBackground();
  }
  void loadBlackdrop();
  void loadChangan3D();

  if (import.meta.env.DEV) {
    // Dev-only introspection hook for automated debugging.
    (window as unknown as Record<string, unknown>).__editorDebug = {
      layers: () =>
        getAssetLayers(editorRuntime.state.modelId).map((l) => ({
          url: l.url,
          label: l.label,
          kind: l.kind,
          hasRef: !!assetRefs[l.url],
          groupVisible: assetRefs[l.url]?.group.visible ?? null,
          meshOpacity: assetRefs[l.url]?.mesh.opacity ?? null,
          panelVisible: assetsLayerPanel.getVisibility(editorRuntime.state.modelId, l),
        })),
      state: () => ({ ...editorRuntime.state }),
    };
  }

  runtime.startRenderLoop();
}

init().catch((err) => {
  console.error("Editor init failed:", err);
  const app = document.getElementById("app");
  if (app) {
    app.innerHTML = `<div style="padding:2rem;font-family:'Lato',sans-serif;color:#c00;"><h2>Editor failed to load</h2><pre>${String(err?.stack || err)}</pre></div>`;
  }
});
