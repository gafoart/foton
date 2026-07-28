import "./style.css";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import Stats from "three/addons/libs/stats.module.js";
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
  applyFloorBrightness,
  applyCeilingBrightness,
} from "@changan/scene-runtime";
import {
  validateManifestSafe,
  assetKey,
  interiorAssetKey,
  loadManifestFromStorage,
  getScale,
  resolveSplatAssetUrl,
  resolveSwatchHex,
  resolveDefaultColorId,
} from "@changan/shared";
import type {
  SceneManifest,
  AssetDef,
  NamedCameraBookmark,
  ModelDef,
} from "@changan/shared";
import {
  AssetManager,
  fetchArrayBufferWithProgress,
} from "./scene/AssetManager.js";
import { StateStore } from "./scene/StateStore.js";
import { getLOD, getQualityProfile, resolveAssetUrl } from "./scene/LODSelector.js";
import { InteractionQualityController } from "./scene/InteractionQuality.js";
import { CameraBookmarksController } from "./scene/CameraBookmarks.js";
import { CameraTravelAnimation } from "./scene/CameraTravel.js";
import { LayerFadeAnimation } from "./scene/LayerFade.js";
import { stripRevealModifier } from "./scene/SplatSpreadReveal.js";
import { SplatSpreadRevealAnimation } from "./scene/SplatSpreadReveal.js";
import { CarClearcoatController } from "./scene/CarClearcoat.js";
import { buildMaskFromBitfield, parseMaskJson } from "./scene/SplatMaskTexture.js";
import { packGrade, type ColorGradePreset } from "./scene/colorGrade.js";
import { CameraClipController } from "./scene/CameraClipModifier.js";
import { createLoadingOverlay } from "./ui/LoadingOverlay.js";
import { initBackgroundMusic } from "./ui/BackgroundMusic.js";
import { AnnotationSystem } from "./scene/AnnotationSystem.js";
import {
  resolveShowroomUrlParams,
  type LoadScope,
} from "./showroom/urlParams.js";
/**
 * Chatbot + feedback capture are loaded dynamically — the chatbot pulls in
 * marked + DOMPurify (~75KB minified together) and feedback capture is gated
 * behind ?test=1 so most users never need it. Both chunks start downloading
 * at module init so they're ready by the time the scene finishes bootstrapping.
 */
type ChatbotPanelModule = typeof import("./ui/ChatbotPanel.js");
type FeedbackCaptureModule = typeof import("./ui/FeedbackCapture.js");
const chatbotPanelModulePromise: Promise<ChatbotPanelModule> = import(
  "./ui/ChatbotPanel.js"
);
const isFeedbackTestMode =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("test") === "1";
const feedbackCaptureModulePromise: Promise<FeedbackCaptureModule> | null =
  isFeedbackTestMode ? import("./ui/FeedbackCapture.js") : null;
import { CarBlobShadow } from "./scene/CarBlobShadow.js";
import { loadLastView, saveLastView } from "./persistence.js";

const MANIFEST_STATIC_URL = "/manifest.json";
/** Local editor dev server – showroom fetches draft from Vite middleware */
const EDITOR_BRIDGE_DEV_URL = "http://localhost:5174/__manifest-draft";

/** Re-assigned after init; reapplies min/max zoom so nothing resets limits between frames. */
let reapplyOrbitZoomFromActiveBookmark: () => void = () => {};

const appRoot = document.getElementById("app")!;
const viewerStage = document.createElement("div");
viewerStage.className = "showroom-viewer-stage";
appRoot.appendChild(viewerStage);

const canvas = document.createElement("canvas");
viewerStage.appendChild(canvas);

// "Volver" — top-left link back to the Changan Venezuela showroom site.
const backLink = document.createElement("a");
backLink.className = "showroom-back-btn";
backLink.href = "https://changanvzla.com/showroom/";
backLink.setAttribute("aria-label", "Volver");
backLink.innerHTML =
  '<svg class="showroom-back-btn-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg><span class="showroom-back-btn-label">Volver</span>';
viewerStage.appendChild(backLink);

// Desktop-only looped background music (skips the fetch entirely on mobile).
initBackgroundMusic(viewerStage);

let cameraTravel: CameraTravelAnimation;

let layerFade: LayerFadeAnimation;

let spreadReveal: SplatSpreadRevealAnimation;

let freeLook!: FreeLookController;

let carBlobShadow: CarBlobShadow | undefined;

const runtime = new SceneRuntime({
  canvas,
  container: viewerStage,
  onTick: () => {
    /**
     * Track active→inactive transitions: when an animation finishes inside
     * `update()`, we need at least one render afterward to capture the final
     * frame (full opacity, modifier stripped, etc.). Otherwise idle-skip
     * leaves the user staring at the penultimate frame mid-reveal.
     */
    const wasCameraTravelActive = cameraTravel?.isActive() ?? false;
    const wasLayerFadeActive = layerFade?.isActive() ?? false;
    const wasSpreadRevealActive = spreadReveal?.isActive() ?? false;

    cameraTravel?.update();
    layerFade?.update();
    spreadReveal?.update();
    carBlobShadow?.sync(assetManager, manifest, stateStore);
    carClearcoat.updateView(runtime.camera);
    cameraClip.updateView(runtime.camera);

    if (
      (wasCameraTravelActive && !cameraTravel?.isActive()) ||
      (wasLayerFadeActive && !layerFade?.isActive()) ||
      (wasSpreadRevealActive && !spreadReveal?.isActive())
    ) {
      runtime.requestRender(6);
    }
  },
  onAfterControlsUpdate: () => {
    if (freeLook?.enabled) {
      freeLook.maintain();
      /**
       * Re-pin controls.target to the freelook gaze every frame. If anything
       * mutates `controls.target` (a stray OrbitControls input handler that
       * leaked through, an annotation hover, etc.), the next implicit
       * `update()` would otherwise yank the camera toward the perturbed
       * target — and since we set `controls.enabled = false` we'd never see
       * input-side changes, only the silent damping/state corruption that
       * showed up as the "vibration after a turn" symptom.
       */
      const lookAt = freeLook.getLookTarget(1);
      runtime.controls.target.copy(lookAt);
    } else {
      reapplyOrbitZoomFromActiveBookmark();
    }
  },
  /**
   * Skip OrbitControls.update() while a cameraTravel is in flight; otherwise
   * its lookAt(target) clobbers the slerped quaternion and the camera ends up
   * looking at the interpolated target point — which during orbit→freelook is
   * still near the orbit target until the very last frame, producing the
   * "interior splat seen from outside" glitch mid-transition.
   */
  shouldSkipControlsUpdate: () =>
    freeLook?.enabled === true || cameraTravel?.isActive() === true,
  /**
   * When freelook is the locked, idle state — no drag, no transition, no
   * fade — skip `renderer.render()` entirely. Spark re-sorts the splat
   * accumulator on every render, and at certain interior angles two splats
   * end up with effectively-tied depths so their order flips frame-to-frame
   * (visible as the model "vibrating" with a perfectly still camera).
   * Freezing the canvas eliminates the re-sort and therefore the shimmer.
   * Render resumes on any input or animation tick — and SceneRuntime
   * unconditionally renders whenever the camera moves, so nothing escapes.
   */
  canSkipRenderWhenIdle: () => {
    if (!freeLook?.enabled) return false;
    if (freeLook.isDragging()) return false;
    if (cameraTravel?.isActive()) return false;
    if (layerFade?.isActive()) return false;
    if (spreadReveal?.isActive()) return false;
    return true;
  },
});

// Default OrbitControls uses two-finger TOUCH.DOLLY_PAN (pinch + drag pans the target).
// Showroom: only orbit + zoom on touch (no two-finger pan).
runtime.controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
// No pan on desktop either (right-drag, Ctrl+left-drag, or arrow keys).
runtime.controls.enablePan = false;

const managedLights = createManagedSceneLights(runtime.scene);

const isApplePlatform =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
    (navigator.userAgent.includes("Mac") && "ontouchend" in document));

cameraTravel = new CameraTravelAnimation({
  camera: runtime.camera,
  controls: runtime.controls,
  duration: isApplePlatform ? 900 : 0,
});

const qualityProfile = getQualityProfile();
runtime.renderer.setPixelRatio(qualityProfile.pixelRatio);
{
  const w = viewerStage.clientWidth || window.innerWidth;
  const h = viewerStage.clientHeight || window.innerHeight;
  runtime.renderer.setSize(w, h);
}
if (qualityProfile.lod === "mobile") {
  runtime.spark.maxStdDev = Math.sqrt(5);
}

freeLook = new FreeLookController(runtime.camera, canvas);

layerFade = new LayerFadeAnimation({ duration: 900 });

spreadReveal = new SplatSpreadRevealAnimation({ duration: 1700 });

const cameraBookmarks = new CameraBookmarksController({
  camera: runtime.camera,
  controls: runtime.controls,
  duration: 0.9,
});

const DEALERSHIP_URL = resolveSplatAssetUrl("/splats/dealership.sog");
const FLOOR_URL = resolveSplatAssetUrl("/splats/floor.glb");
const CEILING_URL = resolveSplatAssetUrl("/splats/ceiling.glb");
const BLACKDROP_URL = resolveSplatAssetUrl("/splats/blackdrop.glb");
const CHANGAN3D_URL = resolveSplatAssetUrl("/splats/changan3D.glb");

const dealershipGroup = new THREE.Group();
dealershipGroup.userData.isDealership = true;
let dealershipVisible = true;

const floorGroup = new THREE.Group();
floorGroup.userData.isFloor = true;

const ceilingGroup = new THREE.Group();
ceilingGroup.userData.isCeiling = true;

const blackdropGroup = new THREE.Group();
blackdropGroup.userData.isBlackdrop = true;
let blackdropVisible = true;

const changan3dGroup = new THREE.Group();
changan3dGroup.userData.isChangan3D = true;

/** Equirect panorama wrap-around. Loaded with the dealership layer (desktop / `?dealer=1`). */
const panoGroup = new THREE.Group();
panoGroup.userData.isPanoBackground = true;
let panoLoadedUrl = "";

/** Extruded car GLB: `/splats/{modelId}/{modelId}.glb`, behind splats for the selected model. */
const carShellGroup = new THREE.Group();
carShellGroup.userData.isCarShell = true;
carShellGroup.userData.modelId = "";
let carShellLoadedModelId = "";
/** Set from URL: `dealer=1` showroom — do not load/show per-model `.glb` shells (dealership is the backdrop). */
let hideCarShellGlbWhenDealership = false;

function disposeObject3DSubtree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m?.dispose();
    }
  });
}

/** Load optional `{modelId}.glb` from the model’s splats folder; no-op if missing. */
async function loadCarShellForModel(modelId: string): Promise<void> {
  if (!modelId) return;
  if (hideCarShellGlbWhenDealership) {
    while (carShellGroup.children.length > 0) {
      const c = carShellGroup.children[0]!;
      carShellGroup.remove(c);
      disposeObject3DSubtree(c);
    }
    carShellGroup.userData.modelId = "";
    carShellLoadedModelId = "";
    carShellGroup.visible = false;
    return;
  }
  if (carShellLoadedModelId === modelId && carShellGroup.children.length > 0) return;

  const url = resolveSplatAssetUrl(`/splats/${modelId}/${modelId}.glb`);
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    while (carShellGroup.children.length > 0) {
      const c = carShellGroup.children[0]!;
      carShellGroup.remove(c);
      disposeObject3DSubtree(c);
    }
    carShellGroup.add(gltf.scene);
    carShellGroup.userData.modelId = modelId;
    carShellLoadedModelId = modelId;
    carShellGroup.visible = true;
    carShellGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.renderOrder = -50;
      }
    });
    const shellT = manifest?.models.find((m) => m.id === modelId)?.carShell?.transform;
    if (shellT) {
      carShellGroup.position.set(shellT.pos[0], shellT.pos[1], shellT.pos[2]);
      carShellGroup.quaternion.set(shellT.rot[0], shellT.rot[1], shellT.rot[2], shellT.rot[3]);
      const [sx, sy, sz] = getScale(shellT);
      carShellGroup.scale.set(sx, sy, sz);
    } else {
      carShellGroup.position.set(0, 0, 0);
      carShellGroup.quaternion.set(0, 0, 0, 1);
      carShellGroup.scale.set(1, 1, 1);
    }
    if (!carShellGroup.parent) {
      runtime.getSplatContainer().add(carShellGroup);
    }
  } catch {
    while (carShellGroup.children.length > 0) {
      const c = carShellGroup.children[0]!;
      carShellGroup.remove(c);
      disposeObject3DSubtree(c);
    }
    carShellGroup.userData.modelId = "";
    carShellLoadedModelId = "";
    carShellGroup.visible = false;
  }
}

function isEnvironmentBackdropChild(obj: THREE.Object3D): boolean {
  return !!(
    obj.userData?.isDealership ||
    obj.userData?.isFloor ||
    obj.userData?.isCeiling ||
    obj.userData?.isBlackdrop ||
    obj.userData?.isChangan3D ||
    obj.userData?.isPanoBackground
  );
}

/**
 * Build (or rebuild) the equirect background sphere from the manifest's panoBackground.
 * Idempotent: skips work when the URL hasn't changed. The sphere is rendered with the
 * texture on its inside (BackSide) and `depthWrite: false` so it doesn't occlude content.
 * Renders behind everything via a low renderOrder.
 */
async function loadPanoBackground(): Promise<void> {
  const def = manifest?.panoBackground;
  if (!def) {
    while (panoGroup.children.length > 0) {
      const c = panoGroup.children[0]!;
      panoGroup.remove(c);
      disposeObject3DSubtree(c);
    }
    panoLoadedUrl = "";
    return;
  }

  const url = resolveSplatAssetUrl(def.url);
  if (url === panoLoadedUrl && panoGroup.children.length > 0) {
    applyPanoTransform();
    return;
  }

  try {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    while (panoGroup.children.length > 0) {
      const c = panoGroup.children[0]!;
      panoGroup.remove(c);
      disposeObject3DSubtree(c);
    }

    const brightness = def.brightness ?? 1;
    // Unit sphere — group `scale` controls effective radius (gizmo-tunable).
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

    applyPanoTransform();
    panoGroup.visible = dealershipVisible;
    if (!panoGroup.parent) runtime.getSplatContainer().add(panoGroup);
    runtime.requestRender(2);
  } catch (err) {
    console.warn("Pano background failed to load:", err);
  }
}

function applyPanoTransform(): void {
  const def = manifest?.panoBackground;
  if (!def) return;
  const t = def.transform;
  panoGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
  panoGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
  const [sx, sy, sz] = getScale(t);
  panoGroup.scale.set(sx, sy, sz);
}

/** LRU / prefetch may hold a group that was never parented to the splat container — it will not render. */
function attachCachedSplatGroupIfNeeded(group: THREE.Object3D): void {
  if (!group.parent) {
    runtime.getSplatContainer().add(group);
  }
}

function syncViewerSceneLook(): void {
  if (!manifest) return;
  applySceneBackground(runtime.renderer, runtime.scene, manifest.scene?.backgroundColor);
  applyManagedSceneLighting(managedLights, manifest.scene?.lighting);
  // Fog only when the backdrop GLB is actually loaded and visible. On desktop
  // the dealership scene is its own room — global fog there washes out the
  // dealership splats. Pass `undefined` to clear `scene.fog`.
  const backdropActive =
    blackdropVisible && blackdropGroup.children.length > 0;
  applySceneFog(
    runtime.scene,
    backdropActive ? manifest.scene?.lighting?.fog : undefined
  );
  applyBlackdropTint(blackdropGroup, manifest.blackdrop?.tint, manifest.blackdrop?.tintStrength);
  applyChangan3DTint(changan3dGroup, manifest.changan3D?.tint);
  applyFloorBrightness(floorGroup, manifest.floor?.brightness);
  applyCeilingBrightness(ceilingGroup, manifest.ceiling?.brightness);
}

async function loadDealershipWithProgress(
  onUnit: (u: number) => void
): Promise<void> {
  try {
    const bytes = await fetchArrayBufferWithProgress(
      DEALERSHIP_URL,
      undefined,
      (f) => onUnit(f * 0.88),
      0,
      0.88
    );
    const mesh = new SplatMesh({
      fileBytes: new Uint8Array(bytes),
      fileType: SplatFileType.PCSOGSZIP,
      ...(qualityProfile.maxSplats !== undefined
        ? { maxSplats: qualityProfile.maxSplats }
        : {}),
      onProgress: (e: ProgressEvent) => {
        if (e.lengthComputable && e.total > 0) {
          const u = e.loaded / e.total;
          onUnit(0.88 + u * 0.12);
        }
      },
    } as Record<string, unknown>);
    await mesh.initialized;
    mesh.maxSh = qualityProfile.maxSh;
    mesh.updateGenerator();
    onUnit(1);
    dealershipGroup.add(mesh);
    cameraClip.attachTo(mesh);
    const t = manifest?.dealership?.transform ?? {
      pos: [0, 0, 0],
      rot: [0, 0, 0, 1],
      scale: 1,
    };
    dealershipGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    dealershipGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    dealershipGroup.scale.set(sx, sy, sz);
    dealershipGroup.visible = dealershipVisible;
    runtime.getSplatContainer().add(dealershipGroup);
  } catch (err) {
    console.warn("Dealership failed to load:", err);
  }
}

async function loadFloor(): Promise<void> {
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(FLOOR_URL);
    while (floorGroup.children.length > 0) {
      const c = floorGroup.children[0]!;
      floorGroup.remove(c);
      disposeObject3DSubtree(c);
    }
    floorGroup.add(gltf.scene);
    floorGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.renderOrder = -40;
      }
    });
    const t = manifest?.floor?.transform ?? {
      pos: [0, 0, 0] as [number, number, number],
      rot: [0, 0, 0, 1] as [number, number, number, number],
      scale: 1 as const,
    };
    floorGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    floorGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    floorGroup.scale.set(sx, sy, sz);
    floorGroup.visible = dealershipVisible;
    runtime.getSplatContainer().add(floorGroup);
    syncViewerSceneLook();
  } catch (err) {
    console.warn("Floor GLB failed to load:", err);
  }
}

async function loadCeiling(): Promise<void> {
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(CEILING_URL);
    while (ceilingGroup.children.length > 0) {
      const c = ceilingGroup.children[0]!;
      ceilingGroup.remove(c);
      disposeObject3DSubtree(c);
    }
    ceilingGroup.add(gltf.scene);
    ceilingGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.renderOrder = -35;
      }
    });
    const t = manifest?.ceiling?.transform ?? {
      pos: [0, 0, 0] as [number, number, number],
      rot: [0, 0, 0, 1] as [number, number, number, number],
      scale: 1 as const,
    };
    ceilingGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    ceilingGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    ceilingGroup.scale.set(sx, sy, sz);
    ceilingGroup.visible = dealershipVisible;
    runtime.getSplatContainer().add(ceilingGroup);
    syncViewerSceneLook();
  } catch (err) {
    console.warn("Ceiling GLB failed to load:", err);
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
    const t = manifest?.blackdrop?.transform ?? {
      pos: [0, 0, 0],
      rot: [0, 0, 0, 1],
      scale: 1,
    };
    blackdropGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    blackdropGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    blackdropGroup.scale.set(sx, sy, sz);
    blackdropGroup.visible = blackdropVisible;
    runtime.getSplatContainer().add(blackdropGroup);
    syncViewerSceneLook();
  } catch (err) {
    console.warn("Blackdrop failed to load:", err);
  }
}

const DEFAULT_CHANGAN3D_TRANSFORM = {
  pos: [0, 0.2, 1.4] as [number, number, number],
  rot: [0, 0, 0, 1] as [number, number, number, number],
  scale: 1 as const,
};

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
    const t = manifest?.changan3D?.transform ?? DEFAULT_CHANGAN3D_TRANSFORM;
    changan3dGroup.position.set(t.pos[0], t.pos[1], t.pos[2]);
    changan3dGroup.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    changan3dGroup.scale.set(sx, sy, sz);
    changan3dGroup.visible = blackdropVisible;
    // Paint the nameplates (15% lighter default, or the manifest tint override)
    // now that the meshes exist — syncViewerSceneLook ran before this load.
    applyChangan3DTint(changan3dGroup, manifest?.changan3D?.tint);
    runtime.getSplatContainer().add(changan3dGroup);
  } catch (err) {
    console.warn("Changan3D GLB failed to load:", err);
  }
}

const deg2rad = (d: number) => (d * Math.PI) / 180;

function applyBookmarkOrbitAngles(bm: NamedCameraBookmark): void {
  const azMin = bm.azimuthMin ?? -180;
  const azMax = bm.azimuthMax ?? 180;
  const polMin = bm.polarMin ?? 5;
  const polMax = bm.polarMax ?? 175;
  runtime.controls.minAzimuthAngle = deg2rad(azMin);
  runtime.controls.maxAzimuthAngle = deg2rad(azMax);
  runtime.controls.minPolarAngle = deg2rad(polMin);
  runtime.controls.maxPolarAngle = deg2rad(polMax);
}

function applyBookmarkFov(bm: NamedCameraBookmark): void {
  const cam = runtime.camera;
  const fov = bm.fov ?? 60;
  cam.fov = THREE.MathUtils.clamp(Number.isFinite(fov) ? fov : 60, 10, 150);
  cam.updateProjectionMatrix();
}

function applyBookmarkOrbitZoom(bm: NamedCameraBookmark): void {
  const minD = bm.minDistance ?? 0;
  runtime.controls.minDistance = Math.max(0, minD);
  runtime.controls.maxDistance =
    bm.maxDistance !== undefined && Number.isFinite(bm.maxDistance)
      ? Math.max(runtime.controls.minDistance, bm.maxDistance)
      : Infinity;
}

function applyBookmarkConstraints(bm: NamedCameraBookmark): void {
  applyBookmarkOrbitAngles(bm);
  applyBookmarkFov(bm);
  applyBookmarkOrbitZoom(bm);
  clearOrbitControlsTransientState(runtime.controls);
  runtime.controls.update();
}

function resetOrbitWideViewer(): void {
  runtime.controls.minAzimuthAngle = -Infinity;
  runtime.controls.maxAzimuthAngle = Infinity;
  runtime.controls.minPolarAngle = 0;
  runtime.controls.maxPolarAngle = Math.PI;
  runtime.controls.minDistance = 0;
  runtime.controls.maxDistance = Infinity;
  runtime.controls.enableRotate = true;
  runtime.controls.enablePan = false;
  runtime.controls.enableZoom = true;
}

/** Apply orbit vs interior free-look for the active programmed bookmark. */
function applyViewerCameraInteraction(bm: NamedCameraBookmark | null): void {
  freeLook.enabled = false;
  if (!bm) {
    resetOrbitWideViewer();
    runtime.controls.enabled = true;
    runtime.controls.update();
    return;
  }
  applyBookmarkDoF(bm);
  if (bm.cameraMode === "freelook") {
    applyBookmarkFov(bm);
    freeLook.clearBookmarkAngleLimits();
    freeLook.setFromBookmark(bm.pos, bm.target);
    runtime.controls.enabled = false;
    runtime.controls.enableRotate = false;
    runtime.controls.enablePan = false;
    runtime.controls.enableZoom = false;
    /**
     * Damping leaves OrbitControls with non-zero `_sphericalDelta`/`_panOffset`
     * even after `clearOrbitControlsTransientState`, because any update() call
     * (e.g. cameraTravel finish frame) re-seeds them from camera↔target. Off
     * during freelook, restored on orbit bookmarks. Without this, the camera
     * wobbles ~1 px at certain interior angles.
     */
    runtime.controls.enableDamping = false;
    /**
     * Pin the orbit target to the freelook gaze so any unforeseen update()
     * path can't yank the camera toward a stale target.
     */
    runtime.controls.target.set(bm.target[0], bm.target[1], bm.target[2]);
    clearOrbitControlsTransientState(runtime.controls);
    freeLook.enabled = true;
  } else {
    resetOrbitWideViewer();
    runtime.controls.enableDamping = true;
    applyBookmarkConstraints(bm);
    runtime.controls.enabled = true;
  }
}

function startViewerCameraTravel(bm: NamedCameraBookmark): void {
  freeLook.enabled = false;
  runtime.controls.enabled = false;
  if (bm.cameraMode === "freelook") {
    runtime.controls.enableRotate = false;
    runtime.controls.enablePan = false;
    runtime.controls.enableZoom = false;
  }
  applyBookmarkDoF(bm);
  cameraTravel.start({
    pos: bm.pos,
    target: bm.target,
    onComplete: () => {
      applyViewerCameraInteraction(bm);
      runtime.scheduleSettleRenders();
    },
  });
}
function applyBookmarkDoF(bm: NamedCameraBookmark): void {
  const fd = bm.focalDistance ?? 5;
  const ap = bm.apertureSize ?? 0.1;
  runtime.spark.focalDistance = fd;
  runtime.spark.apertureAngle = fd > 0 ? 2 * Math.atan(0.5 * ap / fd) : 0;
}

// Kept in sync with the LOD profile so iOS/iPadOS (which `getLOD()` now keeps
// on the desktop tier) also get the desktop asset-manager caps + no prefetch skip.
const isMobile = qualityProfile.lod === "mobile";
const carClearcoat = new CarClearcoatController();
carClearcoat.installConsoleHooks();

/**
 * Load an equirect HDRI/image from `public/hdri/<filename>` into the clearcoat
 * env map. Module-level so both the tuning panel and the per-model FX preset
 * (`{model}_fx.json`) can use it (the panel is gated behind `?clearcoat=1`).
 */
const clearcoatHdriLoader = new RGBELoader();
const clearcoatImgLoader = new THREE.TextureLoader();
/** Load an equirect HDRI/image from a resolved URL; on missing/error → no env. */
function loadClearcoatHdriUrl(url: string): void {
  const onLoad = (tex: THREE.Texture): void => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    carClearcoat.setEnvMap(tex);
  };
  const onError = (): void => carClearcoat.clearEnvMap();
  if (/\.hdri?(\?|$)/i.test(url)) {
    clearcoatHdriLoader.load(url, onLoad, undefined, onError);
  } else {
    clearcoatImgLoader.load(url, onLoad, undefined, onError);
  }
}

/* ---------- Clearcoat debug panel (only with ?clearcoat=1 in the URL) ---------- */
if (
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("clearcoat")
) {
  // Panel tuning loads HDRIs from public/hdri/ (the dropdown list); "none"/empty
  // clears. Production loads per-model from the model folder (see applyClearcoatFx).
  const loadHdri = (filename: string): void => {
    if (!filename || filename.toLowerCase() === "none") {
      carClearcoat.clearEnvMap();
      return;
    }
    loadClearcoatHdriUrl(`/hdri/${filename}`);
  };

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed", top: "12px", left: "12px", zIndex: "9999",
    background: "rgba(0,0,0,0.82)", color: "#eee", fontFamily: "monospace",
    fontSize: "12px", padding: "10px 14px", borderRadius: "10px",
    backdropFilter: "blur(8px)", display: "flex", flexDirection: "column",
    gap: "6px", minWidth: "260px", maxHeight: "90vh", overflowY: "auto",
    border: "1px solid rgba(255,255,255,0.12)",
  });

  const title = document.createElement("div");
  title.textContent = "Clearcoat HDRI";
  Object.assign(title.style, { fontWeight: "bold", fontSize: "13px", marginBottom: "2px" });
  panel.appendChild(title);

  /* HDRI file dropdown + refresh */
  const hdriRow = document.createElement("div");
  Object.assign(hdriRow.style, { display: "flex", alignItems: "center", gap: "4px" });
  const hdriLabel = document.createElement("span");
  hdriLabel.textContent = "hdri";
  Object.assign(hdriLabel.style, { width: "90px", flexShrink: "0" });
  const hdriSelect = document.createElement("select");
  Object.assign(hdriSelect.style, {
    flex: "1", background: "#1a1a1c", color: "#eee", border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: "4px", padding: "3px 4px", fontFamily: "inherit", fontSize: "11px",
  });
  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "↻";
  refreshBtn.title = "Refresh HDRI list";
  Object.assign(refreshBtn.style, {
    background: "transparent", color: "#6cf", border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: "4px", cursor: "pointer", fontSize: "14px", padding: "2px 6px",
    lineHeight: "1",
  });
  hdriRow.append(hdriLabel, hdriSelect, refreshBtn);
  panel.appendChild(hdriRow);

  async function refreshHdriList() {
    hdriSelect.innerHTML = "";
    const none = document.createElement("option");
    none.value = ""; none.textContent = "(none)";
    hdriSelect.appendChild(none);
    try {
      const res = await fetch("/__hdri-list");
      const files = (await res.json()) as string[];
      for (const f of files) {
        const opt = document.createElement("option");
        opt.value = f; opt.textContent = f;
        hdriSelect.appendChild(opt);
      }
    } catch { /* dev endpoint not available in prod */ }
  }

  hdriSelect.addEventListener("change", () => {
    if (hdriSelect.value) loadHdri(hdriSelect.value);
  });
  refreshBtn.addEventListener("click", () => void refreshHdriList());
  void refreshHdriList();

  /* Sliders */
  function addSlider(
    label: string, min: number, max: number, step: number, initial: number,
    onChange: (v: number) => void
  ) {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px" });
    const lbl = document.createElement("span");
    lbl.textContent = label;
    Object.assign(lbl.style, { width: "90px", flexShrink: "0" });
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(min); slider.max = String(max);
    slider.step = String(step); slider.value = String(initial);
    Object.assign(slider.style, { flex: "1", accentColor: "#6cf" });
    const val = document.createElement("span");
    val.textContent = initial.toFixed(2);
    Object.assign(val.style, { width: "40px", textAlign: "right", fontSize: "11px" });
    slider.addEventListener("input", () => {
      const v = parseFloat(slider.value);
      val.textContent = v.toFixed(2);
      onChange(v);
    });
    row.append(lbl, slider, val);
    panel.appendChild(row);
    return slider;
  }

  addSlider("strength",  0, 1,    0.01, 0.12,  (v) => carClearcoat.setStrength(v));
  addSlider("power",     0.1, 16, 0.1,  1.0,   (v) => carClearcoat.setPower(v));
  addSlider("baseRefl",  0, 1,    0.01, 0.0,   (v) => carClearcoat.setBaseRefl(v));
  addSlider("envIntens", 0, 5,    0.05, 1.0,    (v) => carClearcoat.setEnvIntensity(v));
  addSlider("tint R",    0, 2,    0.01, 1.0,    () => syncTint());
  addSlider("tint G",    0, 2,    0.01, 1.0,    () => syncTint());
  addSlider("tint B",    0, 2,    0.01, 1.05,   () => syncTint());
  addSlider("bottomFrac",0, 1,    0.01, 0.35,   (v) => carClearcoat.setBottomFraction(v));
  addSlider("btmFeather",0, 0.5,  0.01, 0.12,   (v) => carClearcoat.setMaskBottomFeather(v));
  addSlider("wrap",      0, 1,    0.01, 0.0,    (v) => carClearcoat.setWrap(v));

  const sliders = panel.querySelectorAll<HTMLInputElement>("input[type=range]");
  function syncTint() {
    const r = parseFloat(sliders[3].value);
    const g = parseFloat(sliders[4].value);
    const b = parseFloat(sliders[5].value);
    carClearcoat.setTint(r, g, b);
  }

  /* --- Separator --- */
  const sep = document.createElement("hr");
  Object.assign(sep.style, { border: "none", borderTop: "1px solid rgba(255,255,255,0.15)", margin: "4px 0" });
  panel.appendChild(sep);

  const sceneTitle = document.createElement("div");
  sceneTitle.textContent = "Scene";
  Object.assign(sceneTitle.style, { fontWeight: "bold", fontSize: "12px", color: "#aaa" });
  panel.appendChild(sceneTitle);

  addSlider("maxStdDev", 0.5, 5, 0.05, parseFloat((runtime.spark.maxStdDev ?? Math.sqrt(8)).toFixed(2)),
    (v) => { runtime.spark.maxStdDev = v; });

  addSlider("floorBright", 0, 2, 0.02, 1.0,
    (v) => { applyFloorBrightness(floorGroup, v); });

  addSlider("ceilBright", 0, 2, 0.02, 1.0,
    (v) => { applyCeilingBrightness(ceilingGroup, v); });

  /* --- Splat selection mask --- */
  const sep2 = document.createElement("hr");
  Object.assign(sep2.style, { border: "none", borderTop: "1px solid rgba(255,255,255,0.15)", margin: "4px 0" });
  panel.appendChild(sep2);

  const maskTitle = document.createElement("div");
  maskTitle.textContent = "Splat Mask";
  Object.assign(maskTitle.style, { fontWeight: "bold", fontSize: "12px", color: "#aaa" });
  panel.appendChild(maskTitle);

  const maskInfo = document.createElement("div");
  maskInfo.textContent = "no mask loaded";
  Object.assign(maskInfo.style, { fontSize: "10px", color: "#888" });
  panel.appendChild(maskInfo);

  const maskRow = document.createElement("div");
  Object.assign(maskRow.style, { display: "flex", gap: "4px", alignItems: "center" });

  const maskFileInput = document.createElement("input");
  maskFileInput.type = "file";
  maskFileInput.accept = ".json,.bin";
  maskFileInput.style.display = "none";

  const maskLoadBtn = document.createElement("button");
  maskLoadBtn.textContent = "Load mask JSON";
  Object.assign(maskLoadBtn.style, {
    background: "transparent", color: "#eee", border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: "4px", cursor: "pointer", fontSize: "11px", padding: "4px 8px",
    fontFamily: "inherit",
  });
  maskLoadBtn.addEventListener("click", () => maskFileInput.click());

  const maskClearBtn = document.createElement("button");
  maskClearBtn.textContent = "Clear";
  Object.assign(maskClearBtn.style, {
    background: "transparent", color: "#f87171", border: "1px solid rgba(248,113,113,0.3)",
    borderRadius: "4px", cursor: "pointer", fontSize: "11px", padding: "4px 8px",
    fontFamily: "inherit",
  });
  maskClearBtn.addEventListener("click", () => {
    carClearcoat.clearSelectionMask();
    maskInfo.textContent = "no mask loaded";
    maskFileInput.value = "";
  });

  maskFileInput.addEventListener("change", async () => {
    const file = maskFileInput.files?.[0];
    if (!file) return;
    try {
      let result;
      if (file.name.endsWith(".bin")) {
        const buf = await file.arrayBuffer();
        result = buildMaskFromBitfield(buf);
      } else {
        const text = await file.text();
        const raw = JSON.parse(text) as unknown;
        result = parseMaskJson(raw);
      }
      if (!result) { maskInfo.textContent = "invalid mask file"; return; }
      carClearcoat.setSelectionMask(result.texture, result.width);
      maskInfo.textContent = `${result.selected.toLocaleString()} / ${result.total.toLocaleString()} splats`;
    } catch (e) {
      maskInfo.textContent = `error: ${(e as Error).message}`;
    }
  });

  maskRow.append(maskFileInput, maskLoadBtn, maskClearBtn);
  panel.appendChild(maskRow);

  const debugRow = document.createElement("div");
  Object.assign(debugRow.style, { display: "flex", alignItems: "center", gap: "6px" });
  const debugCb = document.createElement("input");
  debugCb.type = "checkbox";
  debugCb.addEventListener("change", () => carClearcoat.setDebugTint(debugCb.checked ? 1 : 0));
  const debugLbl = document.createElement("span");
  debugLbl.textContent = "debug tint (red = masked)";
  Object.assign(debugLbl.style, { fontSize: "11px" });
  debugRow.append(debugCb, debugLbl);
  panel.appendChild(debugRow);

  /* --- Toggle + Export --- */
  const toggleRow = document.createElement("div");
  Object.assign(toggleRow.style, { display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" });
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox"; checkbox.checked = true;
  checkbox.addEventListener("change", () => carClearcoat.enable(checkbox.checked));
  const toggleLabel = document.createElement("span");
  toggleLabel.textContent = "enabled";
  toggleRow.append(checkbox, toggleLabel);
  panel.appendChild(toggleRow);

  const exportBtn = document.createElement("button");
  exportBtn.textContent = "Export JSON";
  Object.assign(exportBtn.style, {
    background: "#6cf", color: "#000", border: "none", borderRadius: "4px",
    padding: "5px 10px", cursor: "pointer", fontFamily: "inherit",
    fontSize: "11px", fontWeight: "bold", marginTop: "4px",
  });
  exportBtn.addEventListener("click", () => {
    const allSliders = panel.querySelectorAll<HTMLInputElement>("input[type=range]");
    const params: Record<string, number | string | boolean> = {};
    allSliders.forEach((s) => {
      const label = s.parentElement?.querySelector("span")?.textContent ?? "";
      if (label) params[label] = parseFloat(s.value);
    });
    params["enabled"] = checkbox.checked;
    params["hdri"] = hdriSelect.value;
    const json = JSON.stringify(params, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "clearcoat-params.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  panel.appendChild(exportBtn);

  document.body.appendChild(panel);
}

/**
 * Per-Gaussian camera-distance clip — fades out splats whose centers fall
 * inside a sphere around the camera. Currently attached only to the
 * dealership SplatMesh (where columns / walls intrude on the orbit path).
 */
const cameraClip = new CameraClipController();
cameraClip.installConsoleHooks();

const assetManager = new AssetManager({
  runtime,
  isMobile,
  qualityProfile,
  onAssetLoaded: (key, group) => {
    if (!key.endsWith(":exterior")) return;
    // Attach the worldModifier when a fresh exterior loads. The mask + grade are
    // applied (and awaited) per active model/color in the load flow below, so the
    // body never reveals before its paint is ready — see ensurePaintReady.
    carClearcoat.applyToExterior(key, group);
  },
});

/**
 * Console helper to validate the Photoshock color-grade port: applies the
 * `{model}_color.json` set entry (legacy per-color file as fallback) +
 * `{model}_mask.json` to the currently loaded body. Use on the WHITE car so
 * the grade recolors the base paint.
 *   __colorgrade.apply('alsvin', 'black')   __colorgrade.clear()
 */
if (typeof window !== "undefined") {
  (window as unknown as { __colorgrade?: unknown }).__colorgrade = {
    async apply(modelId: string, colorId: string): Promise<void> {
      const maskUrl = resolveSplatAssetUrl(`/splats/${modelId}/${modelId}_mask.json`);
      const mRes = await fetch(maskUrl).catch(() => null);
      if (mRes?.ok) {
        const mask = parseMaskJson((await mRes.json()) as unknown);
        if (mask) carClearcoat.setSelectionMask(mask.texture, mask.width);
      }
      const set = await loadGradeSet(modelId);
      const preset = set
        ? (set[colorId] ?? null)
        : await fetchLegacyPreset(modelId, colorId);
      if (!preset?.data) {
        console.warn(`[colorgrade] no preset for ${modelId}/${colorId}`);
        return;
      }
      carClearcoat.setGrade(packGrade(preset.data));
      console.log(`[colorgrade] applied ${modelId}/${colorId}`);
    },
    clear(): void {
      carClearcoat.clearGrade();
    },
  };
}

if (qualityProfile.lod === "mobile") {
  const iq = new InteractionQualityController({
    runtime,
    profile: qualityProfile,
    container: viewerStage,
  });
  runtime.controls.addEventListener("start", () => iq.onInteractionStart());
  runtime.controls.addEventListener("end", () => iq.onInteractionEnd());
  freeLook.onDragStart = () => iq.onInteractionStart();
  freeLook.onDragEnd = () => iq.onInteractionEnd();
}

/**
 * iOS Safari and Android Chrome reap memory-heavy tabs that are not visible.
 * When the user tabs away, drop every cached splat that isn't protected (i.e.
 * not the active car's exterior/detail/interior) and cancel any pending
 * prefetches. On return the active layers stay, but everything else has to
 * re-download — a small cost compared to the tab being reloaded outright.
 */
if (isMobile && typeof document !== "undefined") {
  let trimTimer: number | null = null;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (trimTimer !== null) window.clearTimeout(trimTimer);
      /**
       * 2 s grace: brief tab-switches (e.g. share sheet, push notification
       * dismiss) shouldn't trigger an eviction. Anything longer and we
       * trade some re-download for surviving the kill.
       */
      trimTimer = window.setTimeout(() => {
        trimTimer = null;
        const evicted = assetManager.trimToProtected();
        if (evicted > 0) {
          console.log(`[viewer] trimmed ${evicted} cached splats on hide`);
        }
      }, 2000);
    } else if (trimTimer !== null) {
      window.clearTimeout(trimTimer);
      trimTimer = null;
    }
  });
}

carBlobShadow = new CarBlobShadow();
runtime.getSplatContainer().add(carBlobShadow.group);

/** LRU-eviction shield for the active showroom car (exterior + motor + interior). */
function syncPresentationCacheProtectKeys(): void {
  if (!manifest || !stateStore) {
    assetManager.setProtectedPresentationKeys([]);
    return;
  }
  const st = stateStore.getState();
  const m = manifest.models.find((x) => x.id === st.modelId);
  if (!m || !isPresentationMode(m)) {
    assetManager.setProtectedPresentationKeys([]);
    return;
  }
  const keys: string[] = [
    getAssetKey(st.modelId, st.colorId, "exterior"),
    getAssetKey(st.modelId, st.colorId, "detail"),
  ];
  if (m.interior) keys.push(interiorAssetKey(st.modelId));
  assetManager.setProtectedPresentationKeys(keys);
}

const loadingOverlay = createLoadingOverlay("fullscreen");
viewerStage.appendChild(loadingOverlay.el);
loadingOverlay.prepareStartupBlackout();

const showFpsOverlay =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("fps") === "1";

if (showFpsOverlay) {
  const statsEl = document.createElement("div");
  statsEl.className = "stats-overlay";
  const statsFps = document.createElement("span");
  statsFps.className = "stats-fps";
  const statsRam = document.createElement("span");
  statsRam.className = "stats-ram";
  const statsGpu = document.createElement("span");
  statsGpu.className = "stats-gpu";
  statsEl.appendChild(statsFps);
  statsEl.appendChild(document.createTextNode(" | "));
  statsEl.appendChild(statsRam);
  statsEl.appendChild(document.createTextNode(" | "));
  statsEl.appendChild(statsGpu);
  viewerStage.appendChild(statsEl);

  let lastTimeStats = performance.now();
  const fpsSamples: number[] = [];
  const FPS_SAMPLE_COUNT = 30;

  function updateStats(): void {
    const now = performance.now();
    const delta = (now - lastTimeStats) / 1000;
    lastTimeStats = now;
    if (delta > 0 && delta < 1) {
      fpsSamples.push(1 / delta);
      if (fpsSamples.length > FPS_SAMPLE_COUNT) fpsSamples.shift();
    }
    const avg =
      fpsSamples.length > 0
        ? fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length
        : 0;
    statsFps.textContent = avg > 0 ? `${Math.round(avg)} FPS` : "— FPS";
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } })
      .memory;
    if (mem?.usedJSHeapSize !== undefined) {
      const mb = (mem.usedJSHeapSize / 1024 / 1024).toFixed(1);
      statsRam.textContent = `${mb} MB`;
    } else {
      statsRam.textContent = "RAM N/D";
    }
    initGpuInfo();
    if (gpuName) {
      statsGpu.textContent = truncateGpuName(gpuName);
      statsGpu.title = gpuName;
    } else {
      statsGpu.textContent = "GPU N/D";
      statsGpu.title = "";
    }
    requestAnimationFrame(updateStats);
  }
  requestAnimationFrame(updateStats);
}

const showStatsPanel =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("stats") === "1";

if (showStatsPanel) {
  const stats = new Stats();
  stats.dom.style.position = "absolute";
  stats.dom.style.top = "0";
  stats.dom.style.left = "0";
  viewerStage.appendChild(stats.dom);
  function tickStats(): void {
    stats.update();
    requestAnimationFrame(tickStats);
  }
  requestAnimationFrame(tickStats);
}

let gpuName: string | null = null;
function initGpuInfo(): void {
  if (gpuName !== null) return;
  try {
    const gl = (canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (ext) {
      const renderer = (gl as WebGLRenderingContext).getParameter(
        ext.UNMASKED_RENDERER_WEBGL
      );
      gpuName = typeof renderer === "string" ? renderer : null;
    }
  } catch {
    /* ignore */
  }
}

function truncateGpuName(s: string, maxLen = 24): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

const annotationSystem = new AnnotationSystem({
  camera: runtime.camera,
  container: viewerStage,
});
annotationSystem.onBookmarkFocus((bookmark) => {
  const bm = bookmark as NamedCameraBookmark;
  applyBookmarkDoF(bm);
  cameraBookmarks.focusBookmark(bookmark, () => applyViewerCameraInteraction(bm));
});
annotationSystem.startUpdateLoop();

let manifest: SceneManifest | null = null;
let stateStore: StateStore | null = null;
let abortController: AbortController | null = null;
let currentBookmarkIndex = 0;
/** Bumps on stateStore changes so stale `ensureBookmarkLayersLoaded` cannot run `runLayerFade` after color/model updates. */
let bookmarkEnsureGeneration = 0;
/** Bumps when a new presentation bookmark curtain transition starts; invalidates in-flight async fades. */
let bookmarkCurtainFlight = 0;
/** Lazy-load scope from URL (`all` vs `single` model). */
let urlLoadScope: LoadScope = "single";
/** Skip duplicate `loadCurrentAsset` when the model-picker flow already loads. */
let modelSwitchSuppressed = false;

const THUMBNAIL_MAP: Record<string, string> = {
  alsvin: "/thumbnails/alsvin.png",
  cs35: "/thumbnails/cs35.png",
  cs55: "/thumbnails/cs55.png",
  cs95: "/thumbnails/cs95.png",
  "hunter-d": "/thumbnails/hunterDisel.png",
  "hunter-g": "/thumbnails/hunterGasolina.png",
};

const DISPLAY_NAMES: Record<string, string> = {
  alsvin: "ALSVIN",
  cs35: "CS35",
  cs55: "CS55",
  cs95: "CS95",
  "hunter-d": "HUNTER",
  "hunter-g": "HUNTER PLUS",
};

/** Modal model cards: SVG nameplates in `public/ui-images/nameplates`. */
const NAMEPLATE_MAP: Record<string, string> = {
  alsvin: "/ui-images/nameplates/alsvin.svg",
  cs35: "/ui-images/nameplates/cs35.svg",
  cs55: "/ui-images/nameplates/cs55_1.svg",
  cs95: "/ui-images/nameplates/cs95.svg",
  "hunter-d": "/ui-images/nameplates/hunter-d.svg",
  "hunter-g": "/ui-images/nameplates/hunter-g.svg",
};

/**
 * Warm the HTTP cache for every model-picker image (thumbnails + nameplates)
 * in parallel once the first car is fully presented, so opening the model
 * popup never waits on downloads (its `<img loading="lazy">` cards otherwise
 * only start fetching when the modal becomes visible). Fire-and-forget:
 * a failed fetch just means that card falls back to loading on demand.
 */
function preloadUiImages(): void {
  const urls = [
    ...Object.values(THUMBNAIL_MAP),
    ...Object.values(NAMEPLATE_MAP),
  ];
  for (const url of urls) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
  }
}

/**
 * UI chrome icons that are visible (or mounted moments after) when the startup
 * curtain lifts: the bookmark-slot icons in the dock and the chatbot icons.
 * The Volver/music/model-grid buttons use inline SVG, so they need no preload.
 */
const UI_ICON_URLS = [
  "/ui-images/front.svg",
  "/ui-images/side-r.svg",
  "/ui-images/back.svg",
  "/ui-images/trunk.svg",
  "/ui-images/inside-1.svg",
  "/ui-images/inside-2.svg",
  "/ui-images/motor.svg",
  "/ui-images/chat.svg",
  "/ui-images/close.svg",
  "/ui-images/send.svg",
  "/ui-images/profile.png",
];

/** Download + decode one icon; resolves on error too so a missing/blocked
 *  asset can never stall the curtain. */
function preloadOneIcon(url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      // decode() guarantees the bitmap is paint-ready, not merely downloaded.
      if (typeof img.decode === "function") img.decode().then(() => resolve(), () => resolve());
      else resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  });
}

/**
 * Warm + decode every UI chrome icon in parallel, kicked off at module load so
 * it overlaps the (much longer) scene/splat bootstrap and adds no perceptible
 * time. The startup curtain awaits this before lifting so the dock and chat
 * never flash in without their icons — on desktop and mobile alike. Raced
 * against a safety timeout so a stalled request can never strand the curtain.
 */
const uiIconsReady: Promise<void> = Promise.race([
  Promise.all(UI_ICON_URLS.map(preloadOneIcon)).then(() => undefined),
  new Promise<void>((resolve) => setTimeout(resolve, 4000)),
]);

async function loadManifest(): Promise<SceneManifest> {
  /**
   * Inline manifest from the SSR shell (apps/viewer/functions/index.ts).
   * When present this skips an entire fetch round-trip — the JSON is in
   * the HTML response that's already parsed by the time JS runs. Draft
   * check still wins over inline when explicitly requested.
   */
  const enableDraftCheck =
    import.meta.env.DEV ||
    (typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("editorDraft"));
  const draftUrls = enableDraftCheck
    ? import.meta.env.DEV
      ? [EDITOR_BRIDGE_DEV_URL]
      : ["/api/manifest-draft"]
    : [];
  for (const draftUrl of draftUrls) {
    try {
      const res = await fetch(draftUrl, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === "object") {
          const result = validateManifestSafe(data);
          if (result.success) {
            console.log(
              `[viewer] Loaded manifest from editor bridge: ${result.data.models.length} models`
            );
            return result.data;
          }
          console.warn(
            "[viewer] Editor bridge manifest failed validation:",
            result.error.issues
          );
        }
      }
    } catch {
      // Editor not running, CORS, or API unavailable – try next source
    }
  }
  if (!enableDraftCheck && typeof document !== "undefined") {
    const inlineEl = document.getElementById("manifest-data");
    const raw = inlineEl?.textContent?.trim();
    if (raw) {
      try {
        const data = JSON.parse(raw);
        const result = validateManifestSafe(data);
        if (result.success) {
          console.log(
            `[viewer] Loaded manifest from inline SSR: ${result.data.models.length} models`
          );
          return result.data;
        }
        console.warn(
          "[viewer] Inline manifest failed validation, falling back to fetch:",
          result.error.issues
        );
      } catch (e) {
        console.warn("[viewer] Inline manifest JSON parse failed:", e);
      }
    }
  }

  const publishedUrls = import.meta.env.DEV
    ? [MANIFEST_STATIC_URL]
    : ["/api/manifest", MANIFEST_STATIC_URL];
  for (const url of publishedUrls) {
    try {
      /**
       * No `cache: "no-store"` here — the server already sends
       * `Cache-Control: no-store` and the option blocks the browser from
       * reusing the in-flight <link rel=preload as=fetch> entry from index.html.
       */
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const result = validateManifestSafe(data);
        if (result.success) {
          console.log(
            `[viewer] Loaded manifest from ${url}: ${result.data.models.length} models`
          );
          return result.data;
        }
        console.warn(
          `[viewer] Manifest at ${url} failed validation:`,
          result.error.issues
        );
      }
    } catch {
      // fall through
    }
  }
  const stored = loadManifestFromStorage();
  if (stored) {
    console.log("[viewer] Loaded manifest from localStorage");
    return stored;
  }
  throw new Error("No valid manifest found");
}

/**
 * Color token for the shared exterior body. All colors of a model now render
 * from one `{model}_white_ext.sog`, recolored per-color by the paint grade — so
 * the exterior asset key is color-independent (loaded once, never reloaded on a
 * color change). Only `detail` (motor/trunk) remains per-color.
 */
const SHARED_EXTERIOR_COLOR = "base";

function getAssetKey(
  modelId: string,
  colorId: string,
  viewMode: string
): string {
  if (viewMode === "interior") return interiorAssetKey(modelId);
  if (viewMode === "exterior") {
    return assetKey(modelId, SHARED_EXTERIOR_COLOR, "exterior");
  }
  return assetKey(modelId, colorId, "detail");
}

function isPresentationMode(model: {
  cameraBookmarks?: NamedCameraBookmark[];
}): boolean {
  return !!(model.cameraBookmarks && model.cameraBookmarks.length > 0);
}

/**
 * Full-screen fade when crossing interior vs exterior, or when entering/leaving
 * motor / trunk (maletero) bookmarks — matches programmed bookmark ids/names.
 */
function bookmarkTransitionNeedsLoadingCurtain(
  fromVis: { exterior: boolean; detail: boolean; interior: boolean },
  toVis: { exterior: boolean; detail: boolean; interior: boolean },
  fromBm: NamedCameraBookmark | undefined,
  toBm: NamedCameraBookmark
): boolean {
  if (fromVis.interior !== toVis.interior) return true;
  const hay = [fromBm?.id, fromBm?.name, toBm.id, toBm.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /\b(motor|trunk|maletero)\b/.test(hay);
}

/** First programmed camera: named bookmark or exterior bookmark as a synthetic named bookmark. */
function getFirstProgrammedCamera(model: ModelDef): NamedCameraBookmark | null {
  if (model.cameraBookmarks?.length) {
    return model.cameraBookmarks[0] ?? null;
  }
  const b = model.bookmarks.exterior;
  if (!b) return null;
  return {
    id: "legacy-exterior",
    name: "Exterior",
    pos: b.pos,
    target: b.target,
    visibility: { exterior: true, detail: false, interior: false },
  };
}

type AssetLayer = "exterior" | "detail" | "interior";

function applyBookmarkVisibility(
  bm: NamedCameraBookmark,
  modelId: string,
  colorId: string,
  opts?: { revealOpacityLayers?: Set<AssetLayer> }
): void {
  const reveal = opts?.revealOpacityLayers;
  const keys: Array<{ key: string; layer: AssetLayer; visible: boolean }> = [
    {
      key: getAssetKey(modelId, colorId, "exterior"),
      layer: "exterior",
      visible: bm.visibility.exterior,
    },
    {
      key: getAssetKey(modelId, colorId, "detail"),
      layer: "detail",
      visible: bm.visibility.detail,
    },
    {
      key: interiorAssetKey(modelId),
      layer: "interior",
      visible: bm.visibility.interior,
    },
  ];
  for (const { key, layer, visible } of keys) {
    const group = assetManager.getCached(key);
    if (group) {
      attachCachedSplatGroupIfNeeded(group);
      group.visible = visible;
      const mesh = group.children[0] as SplatMesh | undefined;
      if (mesh) {
        if (!reveal?.has(layer) && mesh.objectModifier != null) {
          stripRevealModifier(mesh);
        }
        if (!visible) {
          mesh.opacity = 0;
        } else if (reveal?.has(layer)) {
          /* opacity driven by SplatSpreadReveal or LayerFade */
        } else {
          mesh.opacity = 1;
        }
      }
    }
  }
  /**
   * Visibility/opacity flipped on at least one splat group, but the camera
   * may not have moved (color change while in a freelook bookmark, prefetch
   * landing, fade onComplete). Idle-skip would otherwise leave the change
   * unrendered until the next user input.
   */
  runtime.requestRender(2);
}

function getLayerGroups(
  modelId: string,
  colorId: string
): Array<{ key: string; layer: AssetLayer }> {
  return [
    { key: getAssetKey(modelId, colorId, "exterior"), layer: "exterior" },
    { key: getAssetKey(modelId, colorId, "detail"), layer: "detail" },
    { key: interiorAssetKey(modelId), layer: "interior" },
  ];
}

/**
 * Force a splat group offscreen: clear opacity + any leftover spread/reveal
 * modifier in addition to `group.visible = false`. Spark renders splats whose
 * `mesh.opacity` is non-zero even if a parent group is `visible = false` for a
 * frame, and a stale `objectModifier` will keep painting the previous reveal.
 */
function hideSplatGroup(group: THREE.Object3D): void {
  group.visible = false;
  const mesh = group.children[0] as SplatMesh | undefined;
  if (!mesh) return;
  if (mesh.objectModifier != null) stripRevealModifier(mesh);
  mesh.opacity = 0;
}

function hideOtherModels(activeModelId: string): void {
  const splatContainer = runtime.getSplatContainer();
  for (const child of splatContainer.children) {
    if (isEnvironmentBackdropChild(child as THREE.Object3D)) continue;
    const mid = (child as THREE.Object3D).userData?.modelId as string | undefined;
    if (mid !== undefined && mid !== activeModelId) {
      hideSplatGroup(child as THREE.Object3D);
    }
  }
}

/** Hide exterior/detail splats for this model that belong to another color (after a color change). */
function hideNonActiveColorSplats(modelId: string, activeColorId: string): void {
  const splatContainer = runtime.getSplatContainer();
  for (const child of splatContainer.children) {
    if (isEnvironmentBackdropChild(child as THREE.Object3D)) continue;
    const key = (child as THREE.Object3D).userData?.assetKey as string | undefined;
    if (!key) continue;
    const parts = key.split(":");
    if (parts.length >= 3 && parts[0] === modelId) {
      const color = parts[1];
      const layer = parts[2];
      // Exterior is a single shared body (color comes from the grade), so never
      // hide it on a color change — only the per-color detail (motor/trunk).
      if (layer === "detail" && color !== activeColorId) {
        hideSplatGroup(child as THREE.Object3D);
      }
    }
  }
}

/**
 * Per-model paint selection mask, fetched once and cached (the promise is cached
 * so concurrent callers share one fetch). Tolerates the underscore-model spelling.
 */
const modelMaskCache = new Map<
  string,
  Promise<{ texture: THREE.Texture; width: number } | null>
>();
function fetchModelMask(
  modelId: string
): Promise<{ texture: THREE.Texture; width: number } | null> {
  let p = modelMaskCache.get(modelId);
  if (!p) {
    const altModel = modelId.replace(/-/g, "_");
    const mids = altModel !== modelId ? [modelId, altModel] : [modelId];
    p = (async () => {
      for (const mid of mids) {
        const base = `/splats/${modelId}/${mid}_mask`;
        // Prefer the compact binary bitfield (.bin) — ~100x smaller than the
        // index-list .json. Fall back to .json if no .bin exists.
        const binRes = await fetch(resolveSplatAssetUrl(`${base}.bin`)).catch(() => null);
        if (binRes?.ok) {
          const r = buildMaskFromBitfield(await binRes.arrayBuffer());
          return { texture: r.texture, width: r.width };
        }
        const jsonRes = await fetch(resolveSplatAssetUrl(`${base}.json`)).catch(() => null);
        if (jsonRes?.ok) {
          const r = parseMaskJson((await jsonRes.json()) as unknown);
          if (r) return { texture: r.texture, width: r.width };
        }
      }
      return null;
    })();
    modelMaskCache.set(modelId, p);
  }
  return p;
}

/** Set the active model's paint mask (or clear it if the model has none). */
async function loadModelMask(modelId: string): Promise<void> {
  const m = await fetchModelMask(modelId);
  if (m) carClearcoat.setSelectionMask(m.texture, m.width);
  else carClearcoat.clearSelectionMask();
}

/**
 * Ensure the paint (mask + grade + clearcoat FX) for a model/color is applied,
 * awaited before the body is revealed so it never flashes white/uncolored.
 *
 * The mask and clearcoat FX are per-MODEL (identical across a model's colors), so
 * they're only (re)applied when the model changes. A plain color change therefore
 * does a single grade update — one splat re-generation instead of three — which
 * matters a lot on mobile GPUs (re-running the grade shader over millions of
 * splats is the expensive part of a colour switch).
 */
let lastPaintModelId: string | null = null;
async function ensurePaintReady(modelId: string, colorId: string): Promise<void> {
  if (modelId !== lastPaintModelId) {
    // Kick the color-set fetch in parallel with the (larger) mask download.
    const setPrefetch = loadGradeSet(modelId);
    await loadModelMask(modelId);
    void applyClearcoatFx(modelId);
    await setPrefetch;
    lastPaintModelId = modelId;
  }
  await applyPaintGrade(modelId, colorId);
}

/**
 * Apply the paint color grade for the active color. All colors share the white
 * `_ext.sog`; the color is produced by a Photoshock grade preset applied to the
 * masked paint splats. The base/white color (no preset) reverts to the white body.
 *
 * Presets ship consolidated in ONE file per model — `{model}_color.json` with
 * shape `{ colors: { [colorId]: ColorGradePreset } }` (built by
 * `scripts/merge-color-presets.mjs`). It's fetched once per model and color
 * switches just index into it, so changing color costs zero network requests.
 * When the set file is missing (e.g. older R2 contents) we fall back to the
 * legacy per-color `{model}_{color}_color.json` files.
 */
interface ColorGradeSet {
  colors?: Record<string, ColorGradePreset>;
}
/** Caches the in-flight promise (not the result) so an early background kick
 * (fired alongside the exterior download) and the later awaited call share a
 * single request instead of double-fetching. */
const gradeSetCache = new Map<
  string,
  Promise<Record<string, ColorGradePreset> | null>
>();
function loadGradeSet(
  modelId: string
): Promise<Record<string, ColorGradePreset> | null> {
  let pending = gradeSetCache.get(modelId);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(
          resolveSplatAssetUrl(`/splats/${modelId}/${modelId}_color.json`)
        );
        if (res.ok) {
          const parsed = (await res.json()) as ColorGradeSet;
          if (parsed && typeof parsed === "object" && parsed.colors) {
            return parsed.colors;
          }
        }
      } catch {
        /* missing/offline — legacy per-color fallback below */
      }
      return null;
    })();
    gradeSetCache.set(modelId, pending);
  }
  return pending;
}

/** Legacy per-color preset cache (only used when `{model}_color.json` is absent). */
const gradePresetCache = new Map<string, ColorGradePreset | null>();
async function fetchLegacyPreset(
  modelId: string,
  colorId: string
): Promise<ColorGradePreset | null> {
  const cacheKey = `${modelId}/${colorId}`;
  let preset = gradePresetCache.get(cacheKey);
  if (preset === undefined) {
    // Filenames are usually `{model}_{color}_color.json`, but some Photoshock
    // exports use an underscore in the model part (e.g. hunter_g instead of
    // hunter-g), so try that spelling as a fallback.
    const altModel = modelId.replace(/-/g, "_");
    const names = [`${modelId}_${colorId}_color.json`];
    if (altModel !== modelId) names.push(`${altModel}_${colorId}_color.json`);
    preset = null;
    for (const name of names) {
      try {
        const res = await fetch(resolveSplatAssetUrl(`/splats/${modelId}/${name}`));
        if (res.ok) {
          preset = (await res.json()) as ColorGradePreset;
          break;
        }
      } catch {
        /* try next */
      }
    }
    gradePresetCache.set(cacheKey, preset);
  }
  return preset;
}

async function applyPaintGrade(modelId: string, colorId: string): Promise<void> {
  const set = await loadGradeSet(modelId);
  const preset = set
    ? (set[colorId] ?? null)
    : await fetchLegacyPreset(modelId, colorId);
  // The color may have changed while the preset was fetching.
  const st = stateStore?.getState();
  if (!st || st.modelId !== modelId || st.colorId !== colorId) return;
  if (preset?.data) carClearcoat.setGrade(packGrade(preset.data));
  else carClearcoat.clearGrade();
}

/** Per-model clearcoat FX preset (`{model}_fx.json`) — the panel's export shape. */
interface ClearcoatFx {
  strength?: number;
  power?: number;
  baseRefl?: number;
  envIntens?: number;
  "tint R"?: number;
  "tint G"?: number;
  "tint B"?: number;
  bottomFrac?: number;
  btmFeather?: number;
  wrap?: number;
  maxStdDev?: number;
  enabled?: boolean;
  /** Equirect HDRI filename under public/hdri/ (empty = none). */
  hdri?: string;
}

/**
 * Load and apply the per-model clearcoat config `{model}_fx.json` (strength,
 * power, env reflection, tint, wrap, HDRI, …). Loads with the model alongside
 * the mask; cached per model. Tolerates the underscore-model filename spelling.
 */
const clearcoatFxCache = new Map<string, ClearcoatFx | null>();
async function applyClearcoatFx(modelId: string): Promise<void> {
  let fx = clearcoatFxCache.get(modelId);
  if (fx === undefined) {
    const altModel = modelId.replace(/-/g, "_");
    const names = [`${modelId}_fx.json`];
    if (altModel !== modelId) names.push(`${altModel}_fx.json`);
    fx = null;
    for (const name of names) {
      try {
        const res = await fetch(resolveSplatAssetUrl(`/splats/${modelId}/${name}`));
        if (res.ok) {
          fx = (await res.json()) as ClearcoatFx;
          break;
        }
      } catch {
        /* try next */
      }
    }
    clearcoatFxCache.set(modelId, fx);
  }
  if (!fx) return;
  if (typeof fx.strength === "number") carClearcoat.setStrength(fx.strength);
  if (typeof fx.power === "number") carClearcoat.setPower(fx.power);
  if (typeof fx.baseRefl === "number") carClearcoat.setBaseRefl(fx.baseRefl);
  if (typeof fx.envIntens === "number") carClearcoat.setEnvIntensity(fx.envIntens);
  if (
    typeof fx["tint R"] === "number" ||
    typeof fx["tint G"] === "number" ||
    typeof fx["tint B"] === "number"
  ) {
    carClearcoat.setTint(fx["tint R"] ?? 1, fx["tint G"] ?? 1, fx["tint B"] ?? 1);
  }
  if (typeof fx.bottomFrac === "number") carClearcoat.setBottomFraction(fx.bottomFrac);
  if (typeof fx.btmFeather === "number") carClearcoat.setMaskBottomFeather(fx.btmFeather);
  if (typeof fx.wrap === "number") carClearcoat.setWrap(fx.wrap);
  if (typeof fx.maxStdDev === "number") runtime.spark.maxStdDev = fx.maxStdDev;
  if (typeof fx.enabled === "boolean") carClearcoat.enable(fx.enabled);
  // HDRI lives in the model folder; empty / "none" / missing file → no reflection.
  const hdriName = (fx.hdri ?? "").trim();
  if (hdriName && hdriName.toLowerCase() !== "none") {
    loadClearcoatHdriUrl(resolveSplatAssetUrl(`/splats/${modelId}/${hdriName}`));
  } else {
    carClearcoat.clearEnvMap();
  }
}

function resolveColorForModel(model: ModelDef, preferredColorId: string) {
  return (
    model.colors.find((c) => c.id === preferredColorId) ?? model.colors[0] ?? null
  );
}

const preloadedSplatUrls = new Set<string>();

/**
 * Inject `<link rel=preload as=fetch crossorigin>` for a splat URL so the
 * browser starts the download in parallel with scene/JS bootstrap. The later
 * `fetch()` in AssetManager dedupes against this in-flight request.
 */
function preloadSplat(url: string): void {
  if (!url || preloadedSplatUrls.has(url)) return;
  preloadedSplatUrls.add(url);
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "fetch";
  link.href = url;
  /**
   * Match the later `fetch()` mode so the preload entry is reused, not
   * re-fetched. Cross-origin URLs default to CORS mode in fetch() and need
   * `crossorigin` here; same-origin URLs default to same-origin mode and
   * MUST NOT have `crossorigin`, otherwise the modes mismatch and the
   * browser issues a second request.
   */
  if (/^https?:\/\//i.test(url)) {
    link.crossOrigin = "anonymous";
  }
  document.head.appendChild(link);
}

/**
 * Queue sibling colors of the currently active car for low-priority download.
 * AssetManager.prefetch uses requestIdleCallback + the same semaphore, so this
 * cannot block the active load.
 *
 * Skipped entirely on mobile — every prefetched color adds another 5-15 MB to
 * peak heap + GPU memory, and iOS Safari aggressively reloads tabs that drift
 * past ~250 MB. Color picker switches on mobile still benefit from the edge
 * cache; they just won't be instant.
 */
/**
 * Snapshot current view → localStorage. Wired to every state change and
 * bookmark navigation so a tab reload (manual or OOM kill) restores the
 * exact spot the user was looking at.
 */
function persistCurrentView(): void {
  if (!stateStore) return;
  const s = stateStore.getState();
  saveLastView({
    modelId: s.modelId,
    colorId: s.colorId,
    viewMode: s.viewMode,
    bookmarkIndex: currentBookmarkIndex,
  });
}

function prefetchSiblingColors(modelId: string, activeColorId: string): void {
  if (!manifest || isMobile) return;
  const model = manifest.models.find((m) => m.id === modelId);
  if (!model) return;
  const lod = getLOD();
  const items: Array<{ key: string; assetDef: AssetDef }> = [];
  for (const c of model.colors) {
    if (c.id === activeColorId) continue;
    for (const layer of ["exterior", "detail"] as const) {
      const src = c.assets?.[layer];
      if (!src) continue;
      const key = getAssetKey(modelId, c.id, layer);
      if (assetManager.has(key)) continue;
      items.push({
        key,
        assetDef: { ...src, url: resolveAssetUrl(src, lod) },
      });
    }
  }
  if (items.length > 0) assetManager.prefetch(items);
}

/** Gate load: exterior only; progress 0..1 */
async function loadCarExteriorOnly(
  modelId: string,
  colorId: string,
  signal: AbortSignal,
  onCarProgress: (unit: number) => void
): Promise<void> {
  if (!manifest) throw new Error("No manifest");
  const model = manifest.models.find((m) => m.id === modelId);
  const color = model ? resolveColorForModel(model, colorId) : null;
  if (!model || !color) throw new Error("Model/color not found");

  const lod = getLOD();
  const exteriorDef: AssetDef = {
    ...color.assets.exterior,
    url: resolveAssetUrl(color.assets.exterior, lod),
  };

  hideOtherModels(modelId);

  await assetManager.loadAsset(getAssetKey(modelId, colorId, "exterior"), exteriorDef, {
    signal,
    onProgress: onCarProgress,
  });
}

/**
 * Load motor + interior with no UI; after each asset, re-apply bookmark visibility so hidden layers stay hidden.
 */
async function prefetchPresentationLayersSilently(
  modelId: string,
  colorId: string,
  bm: NamedCameraBookmark,
  signal?: AbortSignal
): Promise<void> {
  if (!manifest) return;
  const model = manifest.models.find((m) => m.id === modelId);
  const color = model ? resolveColorForModel(model, colorId) : null;
  if (!model || !color || !isPresentationMode(model)) return;

  const lod = getLOD();
  const detKey = getAssetKey(modelId, colorId, "detail");
  const intKey = interiorAssetKey(modelId);
  const detailDef: AssetDef = {
    ...color.assets.detail,
    url: resolveAssetUrl(color.assets.detail, lod),
  };
  const interiorDef: AssetDef = {
    ...model.interior,
    url: resolveAssetUrl(model.interior, lod),
  };

  /**
   * Bail before re-applying bookmark visibility if the user changed
   * model/color while we were loading. Without this, a finished prefetch for
   * the old color calls applyBookmarkVisibility with the OLD colorId, which
   * sets `group.visible = true` + `mesh.opacity = 1` on the previous color's
   * exterior — producing the white-and-red overlap when the new color is
   * mid-reveal.
   */
  const stillCurrent = (): boolean => {
    if (signal?.aborted) return false;
    const st = stateStore?.getState();
    return st?.modelId === modelId && st?.colorId === colorId;
  };

  try {
    if (!assetManager.has(detKey)) {
      await assetManager.loadAsset(detKey, detailDef, { signal });
      if (stillCurrent()) applyBookmarkVisibility(bm, modelId, colorId);
    }
    if (!assetManager.has(intKey)) {
      await assetManager.loadAsset(intKey, interiorDef, { signal });
      if (stillCurrent()) applyBookmarkVisibility(bm, modelId, colorId);
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      console.warn("[viewer] Silent prefetch failed:", e);
    }
  }
}

type EnsureBookmarkLayersOpts = {
  signal?: AbortSignal;
  /** 0–100 while each missing layer downloads (sequential). */
  onProgress?: (pct: number) => void;
};

/** Load exterior/detail/interior into cache if missing but needed for a bookmark transition (e.g. after LRU eviction). */
async function ensureBookmarkLayersLoaded(
  modelId: string,
  colorId: string,
  fromVis: { exterior: boolean; detail: boolean; interior: boolean },
  toVis: { exterior: boolean; detail: boolean; interior: boolean },
  opts?: EnsureBookmarkLayersOpts
): Promise<void> {
  if (!manifest) return;
  const model = manifest.models.find((x) => x.id === modelId);
  const color = model ? resolveColorForModel(model, colorId) : null;
  if (!model || !color) return;

  const lod = getLOD();
  type Job = { key: string; def: AssetDef };
  const jobs: Job[] = [];

  for (const { key, layer } of getLayerGroups(modelId, colorId)) {
    if (!fromVis[layer] && !toVis[layer]) continue;
    const cached = assetManager.getCached(key);
    if (cached) {
      attachCachedSplatGroupIfNeeded(cached);
      continue;
    }
    if (layer === "interior") {
      if (!model.interior) continue;
      jobs.push({
        key: interiorAssetKey(modelId),
        def: {
          ...model.interior,
          url: resolveAssetUrl(model.interior, lod),
        },
      });
    } else {
      const src = color.assets[layer];
      if (!src) continue;
      jobs.push({
        key: getAssetKey(modelId, colorId, layer),
        def: {
          ...src,
          url: resolveAssetUrl(src, lod),
        },
      });
    }
  }

  const n = jobs.length;
  const onProgress = opts?.onProgress;
  const signal = opts?.signal;

  if (n === 0) {
    onProgress?.(100);
    return;
  }

  /**
   * Parallel: bookmark transitions need all missing layers, and AssetManager's
   * semaphore caps real network concurrency. Sequential awaits stalled the
   * curtain on the slowest layer × N instead of max(N).
   */
  const progress = new Array<number>(jobs.length).fill(0);
  await Promise.all(
    jobs.map(({ key, def }, i) =>
      assetManager.loadAsset(key, def, {
        signal,
        onProgress: (u) => {
          progress[i] = u;
          let sum = 0;
          for (const v of progress) sum += v;
          onProgress?.((100 * sum) / n);
        },
      })
    )
  );
  onProgress?.(100);
}

function buildLazyTasks(
  scope: LoadScope,
  bootModelId: string,
  preferredColorId: string
): Array<{ key: string; assetDef: AssetDef }> {
  if (!manifest) return [];
  const lod = getLOD();
  const tasks: Array<{ key: string; assetDef: AssetDef }> = [];

  const pushModelLayers = (m: ModelDef) => {
    const color = resolveColorForModel(m, preferredColorId);
    if (!color) return;
    const extK = getAssetKey(m.id, color.id, "exterior");
    tasks.push({
      key: extK,
      assetDef: {
        ...color.assets.exterior,
        url: resolveAssetUrl(color.assets.exterior, lod),
      },
    });
    // Intentionally skip background detail + interior: they flood the LRU and evict the
    // active vehicle's motor/exterior; full layers load when the user selects that model.
  };

  if (scope === "all") {
    for (const m of manifest.models) {
      if (m.id === bootModelId) continue;
      pushModelLayers(m);
    }
  }

  return tasks;
}

/** Other vehicles’ splats in the background — no progress UI. */
function runLazyQueue(scope: LoadScope, bootModelId: string, colorId: string): void {
  const tasks = buildLazyTasks(scope, bootModelId, colorId);
  void (async () => {
    for (const { key, assetDef } of tasks) {
      if (assetManager.has(key)) continue;
      try {
        await assetManager.loadAsset(key, assetDef);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          console.warn("[viewer] Lazy load failed:", key, e);
        }
      }
    }
  })();
}

async function bootstrapPresentationGate(
  showDealer: boolean,
  modelId: string,
  colorId: string,
  signal: AbortSignal,
  initialBookmarkIndex = 0
): Promise<void> {
  if (!manifest || !stateStore) return;

  // Start the mask + color-set fetches ASAP, in parallel with the (much
  // larger) exterior, so paint is ready the moment the body arrives.
  void fetchModelMask(modelId);
  void loadGradeSet(modelId);

  let d = showDealer ? 0 : 1;
  let c = 0;
  const bump = () => {
    const pct = showDealer ? 100 * (0.5 * d + 0.5 * c) : 100 * c;
    loadingOverlay.setProgress(pct);
  };

  const carPromise = loadCarExteriorOnly(modelId, colorId, signal, (t) => {
    c = t;
    bump();
  });

  const dealerPromise = showDealer
    ? Promise.all([
        loadDealershipWithProgress((t) => {
          d = t;
          bump();
        }),
        loadFloor(),
        loadCeiling(),
        loadPanoBackground(),
      ])
    : Promise.resolve();

  await Promise.all([dealerPromise, carPromise]);
  await loadCarShellForModel(modelId);

  // Apply the paint (mask + grade + FX) for the initial color before the boot
  // reveal, so the first paint isn't white (covers deep-links to a color too).
  await ensurePaintReady(modelId, colorId);

  const model = manifest.models.find((m) => m.id === modelId);
  if (!model) return;

  /**
   * If a saved bookmark index was passed in and the model exposes a matching
   * programmed camera, restore that view. Falls back to the first programmed
   * camera (the original behaviour) when the index is out of range.
   */
  const bookmarks = model.cameraBookmarks ?? [];
  const restoredBm =
    bookmarks.length > 0 &&
    initialBookmarkIndex > 0 &&
    initialBookmarkIndex < bookmarks.length
      ? bookmarks[initialBookmarkIndex]
      : null;
  const bm = restoredBm ?? getFirstProgrammedCamera(model);
  currentBookmarkIndex = restoredBm
    ? initialBookmarkIndex
    : 0;
  if (bm) {
    annotationSystem.setVisibleViews(bm.visibility);
    startViewerCameraTravel(bm);

    const extKey = getAssetKey(modelId, colorId, "exterior");
    const extGroup = assetManager.getCached(extKey);
    if (bm.visibility.exterior && extGroup) {
      attachCachedSplatGroupIfNeeded(extGroup);
      applyBookmarkVisibility(bm, modelId, colorId, {
        revealOpacityLayers: new Set<AssetLayer>(["exterior"]),
      });
      spreadReveal.start([extGroup], {
        onComplete: () => applyBookmarkVisibility(bm, modelId, colorId),
      });
    } else {
      applyBookmarkVisibility(bm, modelId, colorId);
    }
    void prefetchPresentationLayersSilently(modelId, colorId, bm, signal);
  }
}

async function bootstrapNonPresentation(
  showDealer: boolean,
  signal: AbortSignal
): Promise<void> {
  if (!manifest || !stateStore) return;
  const { modelId, colorId, viewMode } = stateStore.getState();
  const model = manifest.models.find((m) => m.id === modelId);
  const color = model ? resolveColorForModel(model, colorId) : null;
  if (!model || !color) return;

  let d = showDealer ? 0 : 1;
  let c = 0;
  const bump = () => {
    const pct = showDealer ? 100 * (0.5 * d + 0.5 * c) : 100 * c;
    loadingOverlay.setProgress(pct);
  };

  const lod = getLOD();
  const srcAsset =
    viewMode === "interior"
      ? model.interior
      : viewMode === "detail"
        ? color.assets.detail
        : color.assets.exterior;
  const assetDef: AssetDef = {
    ...srcAsset,
    url: resolveAssetUrl(srcAsset, lod),
  };
  const key = getAssetKey(modelId, colorId, viewMode);

  const carPromise = assetManager.loadAsset(key, assetDef, {
    signal,
    onProgress: (t) => {
      c = t;
      bump();
    },
  }).then(async (group) => {
    hideOtherModels(modelId);
    group.visible = true;
    await loadCarShellForModel(modelId);
    const bookmark = model.bookmarks[viewMode];
    if (bookmark) {
      cameraBookmarks.focusBookmark(bookmark, () => {
        freeLook.enabled = false;
        runtime.controls.enabled = true;
      });
    }
  });

  const dealerPromise = showDealer
    ? Promise.all([
        loadDealershipWithProgress((t) => {
          d = t;
          bump();
        }),
        loadFloor(),
        loadCeiling(),
        loadPanoBackground(),
      ])
    : Promise.resolve();

  await Promise.all([dealerPromise, carPromise]);
  await loadCarShellForModel(modelId);
}

async function loadAllPresentationAssets(): Promise<void> {
  if (!manifest || !stateStore) return;

  abortController?.abort();
  abortController = new AbortController();
  const signal = abortController.signal;

  spreadReveal.cancel();
  layerFade.cancel();

  const { modelId, colorId } = stateStore.getState();
  await loadCarShellForModel(modelId);
  const model = manifest.models.find((m) => m.id === modelId);
  const color = model ? resolveColorForModel(model, colorId) : null;
  if (!model || !color || !isPresentationMode(model)) return;

  const extKey = getAssetKey(modelId, colorId, "exterior");
  const detKey = getAssetKey(modelId, colorId, "detail");
  const intKey = interiorAssetKey(modelId);
  const needExt = !assetManager.has(extKey);
  const needDet = !assetManager.has(detKey);
  const needInt = !assetManager.has(intKey);

  const bookmarks = model.cameraBookmarks!;
  const bm = bookmarks[currentBookmarkIndex] ?? bookmarks[0];
  if (!bm) return;

  /**
   * Only a layer that is VISIBLE in the current bookmark justifies the
   * full-screen curtain (and a blocking fetch). A missing-but-hidden layer —
   * e.g. the per-color `detail` (motor/maletero) while you're looking at the
   * exterior — is warmed in the background instead, so an exterior color
   * change is instant: the shared body just swaps its paint grade (mask +
   * color set are already cached).
   */
  const extBlocks = needExt && bm.visibility.exterior;
  const detBlocks = needDet && bm.visibility.detail;
  const intBlocks = needInt && bm.visibility.interior;
  const useMain = extBlocks || detBlocks || intBlocks;
  /** No camera travel when nothing visible needed fetching (instant swap). */
  const shouldMoveCamera = useMain;

  hideOtherModels(modelId);
  hideNonActiveColorSplats(modelId, colorId);
  // Start the mask + color-set fetches ASAP (in parallel with the exterior) so
  // they're ready by the time we gate the reveal on them below.
  void fetchModelMask(modelId);
  void loadGradeSet(modelId);

  for (const key of [extKey, detKey, intKey]) {
    const g = assetManager.getCached(key);
    if (g) attachCachedSplatGroupIfNeeded(g);
  }

  const lod = getLOD();
  const exteriorDef: AssetDef = {
    ...color.assets.exterior,
    url: resolveAssetUrl(color.assets.exterior, lod),
  };
  const detailDef: AssetDef = {
    ...color.assets.detail,
    url: resolveAssetUrl(color.assets.detail, lod),
  };
  const interiorDef: AssetDef = {
    ...model.interior,
    url: resolveAssetUrl(model.interior, lod),
  };

  const nMainJobs =
    Number(extBlocks) + Number(detBlocks) + Number(intBlocks);
  const p = {
    ext: extBlocks ? 0 : 1,
    det: detBlocks ? 0 : 1,
    int: intBlocks ? 0 : 1,
  };
  const repMain = () => {
    if (!useMain || nMainJobs === 0) return;
    const sum =
      (extBlocks ? p.ext : 0) +
      (detBlocks ? p.det : 0) +
      (intBlocks ? p.int : 0);
    loadingOverlay.setProgress((100 * sum) / nMainJobs);
  };

  let usedCurtain = false;
  if (useMain) {
    loadingOverlay.show();
    await loadingOverlay.fadeCurtainToBlack(220);
    usedCurtain = true;
  }

  try {
    /**
     * Parallel fetch: AssetManager's semaphore caps concurrency anyway, but
     * Promise.all lets exterior + detail download together (huge win on color
     * change, where both are typically uncached and the semaphore has slack).
     */
    const jobs: Array<Promise<unknown>> = [];
    /**
     * Missing but not visible in this bookmark → warm it in the background so
     * the visible reveal isn't blocked (e.g. the per-color motor splat on a
     * color change viewed from the exterior).
     */
    const warmInBackground = (key: string, def: AssetDef) => {
      void assetManager.loadAsset(key, def, { signal }).catch(() => {});
    };

    if (extBlocks) {
      jobs.push(
        assetManager.loadAsset(extKey, exteriorDef, {
          signal,
          onProgress: (u) => {
            p.ext = u;
            repMain();
          },
        })
      );
    } else if (needExt) {
      warmInBackground(extKey, exteriorDef);
    }
    if (detBlocks) {
      jobs.push(
        assetManager.loadAsset(detKey, detailDef, {
          signal,
          onProgress: (u) => {
            p.det = u;
            repMain();
          },
        })
      );
    } else if (needDet) {
      warmInBackground(detKey, detailDef);
    }
    if (intBlocks) {
      jobs.push(
        assetManager.loadAsset(intKey, interiorDef, {
          signal,
          onProgress: (u) => {
            p.int = u;
            repMain();
          },
        })
      );
    } else if (needInt) {
      warmInBackground(intKey, interiorDef);
    }
    if (jobs.length > 0) await Promise.all(jobs);

    // Apply the paint (mask + grade) for the active model/color BEFORE revealing
    // so the body never appears white/uncolored on a model or color change.
    if (!signal.aborted) await ensurePaintReady(modelId, colorId);

    if (bm) {
      if (shouldMoveCamera) {
        startViewerCameraTravel(bm);
        await cameraTravel.waitUntilIdle();
      } else {
        applyViewerCameraInteraction(bm);
      }

      const spreadLayers = new Set<AssetLayer>();
      const spreadGroups: THREE.Object3D[] = [];
      if (needExt && bm.visibility.exterior) {
        spreadLayers.add("exterior");
        const g = assetManager.getCached(extKey);
        if (g) {
          attachCachedSplatGroupIfNeeded(g);
          spreadGroups.push(g);
        }
      }
      if (needDet && bm.visibility.detail) {
        spreadLayers.add("detail");
        const g = assetManager.getCached(detKey);
        if (g) {
          attachCachedSplatGroupIfNeeded(g);
          spreadGroups.push(g);
        }
      }

      const interiorFetchedThisPass = intBlocks;
      const interiorFade =
        interiorFetchedThisPass &&
        bm.visibility.interior &&
        assetManager.has(intKey);
      const intGroup = interiorFade ? assetManager.getCached(intKey) : undefined;
      if (intGroup) attachCachedSplatGroupIfNeeded(intGroup);

      const revealOpacity = new Set(spreadLayers);
      if (interiorFade) revealOpacity.add("interior");

      const useRevealAnim = spreadGroups.length > 0 || interiorFade;

      if (useRevealAnim) {
        applyBookmarkVisibility(bm, modelId, colorId, {
          revealOpacityLayers: revealOpacity,
        });
        annotationSystem.setVisibleViews(bm.visibility);

        let pending = 0;
        const done = () => {
          pending--;
          if (pending <= 0) {
            applyBookmarkVisibility(bm, modelId, colorId);
          }
        };

        if (spreadGroups.length > 0) {
          pending++;
          spreadReveal.start(spreadGroups, { onComplete: done });
        }
        if (interiorFade && intGroup) {
          pending++;
          layerFade.start(
            [{ group: intGroup, fromVisible: false, toVisible: true }],
            done
          );
        }
        if (pending <= 0) {
          applyBookmarkVisibility(bm, modelId, colorId);
        }
      } else {
        applyBookmarkVisibility(bm, modelId, colorId);
        annotationSystem.setVisibleViews(bm.visibility);
      }
    }
    showroomUI?.update();
    prefetchSiblingColors(modelId, colorId);
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      console.error("Failed to load presentation assets:", err);
    }
  } finally {
    if (usedCurtain) {
      await loadingOverlay.fadeCurtainToClear(280);
    }
    loadingOverlay.hide();
  }
}

async function loadCurrentAsset(): Promise<void> {
  if (!manifest || !stateStore) return;

  abortController?.abort();
  abortController = new AbortController();
  const signal = abortController.signal;

  const { modelId, colorId, viewMode } = stateStore.getState();
  const model = manifest.models.find((m) => m.id === modelId);
  const color = model ? resolveColorForModel(model, colorId) : null;
  if (!model || !color) return;

  if (isPresentationMode(model)) {
    await loadAllPresentationAssets();
    return;
  }

  annotationSystem.setVisibleViews(null);

  let assetDef: AssetDef;
  if (viewMode === "interior") {
    assetDef = model.interior;
  } else {
    assetDef = color.assets[viewMode];
  }
  if (!assetDef) return;

  loadingOverlay.show();
  await loadingOverlay.fadeCurtainToBlack(220);

  const lod = getLOD();
  const resolvedAsset: AssetDef = {
    ...assetDef,
    url: resolveAssetUrl(assetDef, lod),
  };

  const key = getAssetKey(modelId, colorId, viewMode);

  const splatContainer = runtime.getSplatContainer();
  for (const child of splatContainer.children) {
    if (isEnvironmentBackdropChild(child as THREE.Object3D)) continue;
    child.visible = false;
  }

  try {
    const mesh = await assetManager.loadAsset(key, resolvedAsset, {
      signal,
      onProgress: (u) => loadingOverlay.setProgress(u * 100),
    });
    hideOtherModels(modelId);
    mesh.visible = true;
    await loadCarShellForModel(modelId);

    const bookmark = model.bookmarks[viewMode];
    if (bookmark) {
      cameraBookmarks.focusBookmark(bookmark, () => {
        freeLook.enabled = false;
        runtime.controls.enabled = true;
      });
      await cameraBookmarks.waitUntilIdle();
    }

    await loadingOverlay.fadeCurtainToClear(280);

    if (viewMode === "exterior" && model.interior) {
      const interiorKey = interiorAssetKey(modelId);
      const lodResolved = {
        ...model.interior,
        url: resolveAssetUrl(model.interior, lod),
      };
      assetManager.prefetch([{ key: interiorKey, assetDef: lodResolved }]);
    }

    prefetchSiblingColors(modelId, colorId);
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      console.error("Failed to load asset:", err);
    }
    await loadingOverlay.fadeCurtainToClear(160);
  } finally {
    loadingOverlay.hide();
  }
}

let showroomUI: { update: () => void } | null = null;

let chatbotPanel: ReturnType<ChatbotPanelModule["createChatbotPanel"]> | null =
  null;

/** Pixel ratio del visor antes de abrir el chat en móvil (se restaura al cerrar). */
let viewerPixelRatioBeforeMobileChat: number | null = null;

function applyViewerPixelRatioForMobileChat(reduced: boolean): void {
  const w = viewerStage.clientWidth || window.innerWidth;
  const h = viewerStage.clientHeight || window.innerHeight;
  if (reduced) {
    if (viewerPixelRatioBeforeMobileChat === null) {
      viewerPixelRatioBeforeMobileChat = runtime.renderer.getPixelRatio();
    }
    runtime.renderer.setPixelRatio(1);
  } else {
    if (viewerPixelRatioBeforeMobileChat !== null) {
      runtime.renderer.setPixelRatio(viewerPixelRatioBeforeMobileChat);
      viewerPixelRatioBeforeMobileChat = null;
    }
  }
  runtime.renderer.setSize(w, h);
}

/**
 * Maps bookmark names from the manifest to SVG icon paths and tooltips.
 * The dock is built dynamically from each model's `cameraBookmarks` array.
 */
const BOOKMARK_ICON_MAP: Record<string, string> = {
  front: "/ui-images/front.svg",
  side: "/ui-images/side-r.svg",
  "side-r": "/ui-images/side-r.svg",
  back: "/ui-images/back.svg",
  trunk: "/ui-images/trunk.svg",
  "inside-1": "/ui-images/inside-1.svg",
  "inside-2": "/ui-images/inside-2.svg",
  "interior-1": "/ui-images/inside-1.svg",
  "interior-2": "/ui-images/inside-2.svg",
  motor: "/ui-images/motor.svg",
};

const BOOKMARK_TOOLTIP_MAP: Record<string, string> = {
  front: "Frente",
  side: "Lateral",
  "side-r": "Lateral",
  back: "Trasero",
  trunk: "Maletera",
  "inside-1": "Volante",
  "inside-2": "Habitáculo",
  "interior-1": "Volante",
  "interior-2": "Habitáculo",
  motor: "Motor",
};

function bookmarkSlotIconHtml(bmName: string): string {
  const src = BOOKMARK_ICON_MAP[bmName] ?? "/ui-images/front.svg";
  return `<img class="showroom-bm-slot-icon" src="${src}" width="26" height="26" alt="" decoding="async" loading="lazy" />`;
}

/** Mobile-only: narrow phones show 3 slots, wider (still ≤600px) show 5. */
const MOBILE_BOOKMARK_MEDIA = "(max-width: 600px)";
const MOBILE_BOOKMARK_NARROW_PX = 400;

function getMobileBookmarkWindowSize(): number {
  if (typeof window === "undefined") return 5;
  return window.innerWidth <= MOBILE_BOOKMARK_NARROW_PX ? 3 : 5;
}

function mobileBookmarkVisibleRange(
  selectedIndex: number,
  slotCount: number,
  windowSize: number
): { start: number; end: number } {
  if (slotCount <= windowSize) {
    return { start: 0, end: Math.max(0, slotCount - 1) };
  }
  const half = Math.floor(windowSize / 2);
  let start = selectedIndex - half;
  let end = start + windowSize - 1;
  if (start < 0) {
    start = 0;
    end = windowSize - 1;
  }
  if (end >= slotCount) {
    end = slotCount - 1;
    start = end - (windowSize - 1);
  }
  return { start, end };
}

function goToBookmarkIndex(idx: number): void {
  if (!manifest || !stateStore) return;
  const s = stateStore.getState();
  const m = manifest.models.find((x) => x.id === s.modelId);
  const list = m?.cameraBookmarks ?? [];
  if (list.length === 0) return;
  if (idx < 0 || idx >= list.length) return;
  if (idx === currentBookmarkIndex) return;

  const bm = list[idx];
  if (!bm) return;

  const fromBm = list[currentBookmarkIndex];
  const fromVis = fromBm?.visibility ?? {
    exterior: true,
    detail: true,
    interior: true,
  };
  const toVis = bm.visibility;

  const useCurtain =
    !!m &&
    isPresentationMode(m) &&
    bookmarkTransitionNeedsLoadingCurtain(fromVis, toVis, fromBm, bm);

  spreadReveal.cancel();
  layerFade.cancel();

  if (!useCurtain) {
    currentBookmarkIndex = idx;
    persistCurrentView();
    startViewerCameraTravel(bm);
    showroomUI?.update();

    const ensureGen = ++bookmarkEnsureGeneration;

    const runLayerFade = (): void => {
      const layerInfos = getLayerGroups(s.modelId, s.colorId)
        .map(({ key, layer }) => {
          const group = assetManager.getCached(key);
          if (group) attachCachedSplatGroupIfNeeded(group);
          return {
            group: group!,
            fromVisible: fromVis[layer],
            toVisible: toVis[layer],
            key,
            layer,
          };
        })
        .filter((info) => info.group);

      layerFade.start(
        layerInfos.map(({ group, fromVisible, toVisible }) => ({ group, fromVisible, toVisible })),
        () => {
          applyBookmarkVisibility(bm, s.modelId, s.colorId);
          annotationSystem.setVisibleViews(bm.visibility);
        }
      );
    };

    const needEnsure = getLayerGroups(s.modelId, s.colorId).some(({ key, layer }) => {
      if (!fromVis[layer] && !toVis[layer]) return false;
      const g = assetManager.getCached(key);
      if (!g) return true;
      return !g.parent;
    });

    if (needEnsure) {
      void ensureBookmarkLayersLoaded(s.modelId, s.colorId, fromVis, toVis).then(
        () => {
          if (ensureGen !== bookmarkEnsureGeneration) return;
          runLayerFade();
        },
        (e) => {
          if ((e as Error).name !== "AbortError") {
            console.warn("[viewer] ensureBookmarkLayersLoaded failed:", e);
          }
          if (ensureGen !== bookmarkEnsureGeneration) return;
          runLayerFade();
        }
      );
    } else {
      runLayerFade();
    }
    return;
  }

  bookmarkCurtainFlight++;
  const curtainFlight = bookmarkCurtainFlight;

  void (async () => {
    loadingOverlay.show();
    loadingOverlay.setProgress(0);
    try {
      await loadingOverlay.fadeCurtainToBlack(220);
    } catch {
      loadingOverlay.hide();
      return;
    }

    if (curtainFlight !== bookmarkCurtainFlight) {
      await loadingOverlay.fadeCurtainToClear(160);
      loadingOverlay.hide();
      return;
    }

    currentBookmarkIndex = idx;
    persistCurrentView();
    startViewerCameraTravel(bm);
    showroomUI?.update();

    const ensureGen = ++bookmarkEnsureGeneration;

    const runLayerFadeOnce = (): void => {
      const layerInfos = getLayerGroups(s.modelId, s.colorId)
        .map(({ key, layer }) => {
          const group = assetManager.getCached(key);
          if (group) attachCachedSplatGroupIfNeeded(group);
          return {
            group: group!,
            fromVisible: fromVis[layer],
            toVisible: toVis[layer],
            key,
            layer,
          };
        })
        .filter((info) => info.group);

      layerFade.start(
        layerInfos.map(({ group, fromVisible, toVisible }) => ({ group, fromVisible, toVisible })),
        () => {
          applyBookmarkVisibility(bm, s.modelId, s.colorId);
          annotationSystem.setVisibleViews(bm.visibility);
        }
      );
    };

    const needEnsure = getLayerGroups(s.modelId, s.colorId).some(({ key, layer }) => {
      if (!fromVis[layer] && !toVis[layer]) return false;
      const g = assetManager.getCached(key);
      if (!g) return true;
      return !g.parent;
    });

    try {
      if (needEnsure) {
        try {
          await ensureBookmarkLayersLoaded(s.modelId, s.colorId, fromVis, toVis, {
            onProgress: (pct) => loadingOverlay.setProgress(pct),
          });
        } catch (e) {
          if ((e as Error).name !== "AbortError") {
            console.warn("[viewer] ensureBookmarkLayersLoaded failed:", e);
          }
        }
      } else {
        loadingOverlay.setProgress(100);
      }

      if (curtainFlight !== bookmarkCurtainFlight || ensureGen !== bookmarkEnsureGeneration) {
        await loadingOverlay.fadeCurtainToClear(160);
        return;
      }

      runLayerFadeOnce();
      await Promise.all([
        layerFade.waitUntilIdle(),
        cameraTravel.waitUntilIdle(),
      ]);

      if (curtainFlight !== bookmarkCurtainFlight || ensureGen !== bookmarkEnsureGeneration) {
        await loadingOverlay.fadeCurtainToClear(160);
        return;
      }

      await loadingOverlay.fadeCurtainToClear(280);
      runtime.scheduleSettleRenders();
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.warn("[viewer] bookmark curtain transition failed:", e);
      }
      await loadingOverlay.fadeCurtainToClear(160);
    } finally {
      loadingOverlay.hide();
    }
  })();
}

function navigateBookmark(delta: number): void {
  if (!manifest || !stateStore) return;
  const s = stateStore.getState();
  const m = manifest.models.find((x) => x.id === s.modelId);
  const list = m?.cameraBookmarks ?? [];
  if (list.length === 0) return;

  let idx = currentBookmarkIndex + delta;
  if (idx < 0) idx = list.length - 1;
  if (idx >= list.length) idx = 0;
  goToBookmarkIndex(idx);
}

async function handleModelSelectFromModal(m: ModelDef): Promise<void> {
  if (!manifest || !stateStore) return;
  const state = stateStore.getState();
  if (m.id === state.modelId) return;

  // Always start a new model on its WHITE base body (the color grade is applied
  // per color afterwards). Kick off the mask fetch immediately so it's ready by
  // the time the much larger exterior .sog finishes downloading.
  const whiteColor = m.colors.find(
    (c) => c.id === "white" || c.assets.exterior.url.includes("white_ext")
  );
  const colorId = whiteColor?.id ?? resolveDefaultColorId(m.colors) ?? state.colorId;
  void fetchModelMask(m.id);
  void loadGradeSet(m.id);

  appRoot.classList.add("viewer-busy");
  abortController?.abort();
  abortController = new AbortController();
  const signal = abortController.signal;

  const bm = getFirstProgrammedCamera(m);

  loadingOverlay.show();
  loadingOverlay.setProgress(0);
  await loadingOverlay.fadeCurtainToBlack(220);

  if (bm) {
    startViewerCameraTravel(bm);
  }

  let usedCurtain = true;

  try {
    let c = 0;
    const loadP = loadCarExteriorOnly(m.id, colorId, signal, (t) => {
      c = t;
      loadingOverlay.setProgress(100 * c);
    });
    const camP = bm ? cameraTravel.waitUntilIdle() : Promise.resolve();
    await Promise.all([loadP, camP]);
    await loadCarShellForModel(m.id);

    if (bm) {
      annotationSystem.setVisibleViews(bm.visibility);
      const extKey = getAssetKey(m.id, colorId, "exterior");
      const extGroup = assetManager.getCached(extKey);
      if (bm.visibility.exterior && extGroup) {
        attachCachedSplatGroupIfNeeded(extGroup);
        applyBookmarkVisibility(bm, m.id, colorId, {
          revealOpacityLayers: new Set<AssetLayer>(["exterior"]),
        });
        spreadReveal.start([extGroup], {
          onComplete: () => applyBookmarkVisibility(bm, m.id, colorId),
        });
      } else {
        applyBookmarkVisibility(bm, m.id, colorId);
      }
    }
    currentBookmarkIndex = 0;
    modelSwitchSuppressed = true;
    stateStore.update({
      modelId: m.id,
      colorId,
      viewMode: "exterior",
    });

    // Gate the reveal on the mask: don't clear the curtain until the paint mask
    // is fully loaded (white base — no grade). The mask fetch was kicked off at
    // the top, so this usually resolves immediately. Done after stateStore.update
    // so applyPaintGrade's stale-state guard sees the new model/color.
    if (!signal.aborted) await ensurePaintReady(m.id, colorId);

    await loadingOverlay.fadeCurtainToClear(280);
    runtime.scheduleSettleRenders();

    if (isPresentationMode(m) && bm) {
      appRoot.classList.remove("viewer-busy");
      void prefetchPresentationLayersSilently(m.id, colorId, bm, signal);
    } else {
      await loadCurrentAsset();
    }
    modelSwitchSuppressed = false;
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      console.error("Model switch failed:", err);
    }
  } finally {
    modelSwitchSuppressed = false;
    if (usedCurtain) {
      await loadingOverlay.fadeCurtainToClear(280);
    }
    loadingOverlay.hide();
    appRoot.classList.remove("viewer-busy");
  }
}

function buildShowroomUI(handlers: {
  onModelSelect: (m: ModelDef) => Promise<void>;
}): { update: () => void } {
  const dock = document.createElement("div");
  dock.className = "showroom-dock";

  const colorRow = document.createElement("div");
  colorRow.className = "showroom-color-row";

  const navShell = document.createElement("div");
  navShell.className = "showroom-nav-shell";

  const navRow = document.createElement("div");
  navRow.className = "showroom-nav-row";

  const bookmarkSlotsViewport = document.createElement("div");
  bookmarkSlotsViewport.className = "showroom-bookmark-slots-viewport";

  const bookmarkSlotsEl = document.createElement("div");
  bookmarkSlotsEl.className = "showroom-bookmark-slots";

  let bookmarkSlotBtns: HTMLButtonElement[] = [];

  function rebuildBookmarkSlots(): void {
    bookmarkSlotsEl.innerHTML = "";
    bookmarkSlotBtns = [];
    if (!manifest || !stateStore) return;
    const s = stateStore.getState();
    const m = manifest.models.find((x) => x.id === s.modelId);
    const bookmarks = m?.cameraBookmarks ?? [];
    for (let i = 0; i < bookmarks.length; i++) {
      const bm = bookmarks[i]!;
      const slotBtn = document.createElement("button");
      slotBtn.type = "button";
      slotBtn.className = "showroom-bm-slot";
      slotBtn.dataset.slotIndex = String(i);
      slotBtn.dataset.slot = bm.name;
      slotBtn.innerHTML = bookmarkSlotIconHtml(bm.name);
      const tip = document.createElement("span");
      tip.className = "showroom-bm-slot-tooltip";
      tip.textContent = BOOKMARK_TOOLTIP_MAP[bm.name] ?? bm.name;
      slotBtn.appendChild(tip);
      const idx = i;
      slotBtn.addEventListener("click", () => goToBookmarkIndex(idx));
      bookmarkSlotsEl.appendChild(slotBtn);
      bookmarkSlotBtns.push(slotBtn);
    }
  }
  rebuildBookmarkSlots();

  bookmarkSlotsViewport.appendChild(bookmarkSlotsEl);

  const modelBtn = document.createElement("button");
  modelBtn.type = "button";
  modelBtn.className = "showroom-model-btn";
  modelBtn.title = "Elegir modelo";
  modelBtn.setAttribute("aria-label", "Elegir modelo");
  modelBtn.innerHTML = `<svg class="showroom-model-btn-icon" width="26" height="26" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="1" y="1" width="5" height="5" rx="1"/><rect x="8" y="1" width="5" height="5" rx="1"/><rect x="1" y="8" width="5" height="5" rx="1"/><rect x="8" y="8" width="5" height="5" rx="1"/></svg>`;

  navRow.appendChild(bookmarkSlotsViewport);
  navRow.appendChild(modelBtn);

  navShell.appendChild(navRow);
  dock.appendChild(colorRow);
  dock.appendChild(navShell);
  viewerStage.appendChild(dock);

  const prevArrow = document.createElement("button");
  prevArrow.type = "button";
  prevArrow.className = "showroom-arrow showroom-arrow-edge showroom-arrow-edge--prev";
  prevArrow.innerHTML = "&#8249;";
  prevArrow.title = "Vista anterior";
  prevArrow.setAttribute("aria-label", "Vista anterior");
  prevArrow.addEventListener("click", () => navigateBookmark(-1));

  const nextArrow = document.createElement("button");
  nextArrow.type = "button";
  nextArrow.className = "showroom-arrow showroom-arrow-edge showroom-arrow-edge--next";
  nextArrow.innerHTML = "&#8250;";
  nextArrow.title = "Vista siguiente";
  nextArrow.setAttribute("aria-label", "Vista siguiente");
  nextArrow.addEventListener("click", () => navigateBookmark(1));

  viewerStage.appendChild(prevArrow);
  viewerStage.appendChild(nextArrow);

  const overlay = document.createElement("div");
  overlay.className = "showroom-modal-overlay";
  overlay.hidden = true;

  const modal = document.createElement("div");
  modal.className = "showroom-modal";

  const grid = document.createElement("div");
  grid.className = "showroom-modal-grid";

  modal.appendChild(grid);
  overlay.appendChild(modal);
  viewerStage.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
  modelBtn.addEventListener("click", () => {
    overlay.hidden = !overlay.hidden;
  });

  function update(): void {
    if (!manifest || !stateStore) return;
    const state = stateStore.getState();
    const model = manifest.models.find((mm) => mm.id === state.modelId);
    const bookmarks = model?.cameraBookmarks ?? [];
    const hasBookmarks = bookmarks.length > 0;

    colorRow.innerHTML = "";
    if (model && model.colors.length > 1) {
      for (const c of model.colors) {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className =
          "showroom-color-dot" + (c.id === state.colorId ? " selected" : "");
        dot.style.backgroundColor = resolveSwatchHex(state.modelId, c.id);
        dot.title = c.name;
        dot.addEventListener("click", () => {
          stateStore!.setColor(c.id);
        });
        colorRow.appendChild(dot);
      }
      colorRow.style.display = "";
    } else {
      colorRow.style.display = "none";
    }

    if (hasBookmarks) {
      rebuildBookmarkSlots();
      prevArrow.style.visibility = "";
      nextArrow.style.visibility = "";
      bookmarkSlotsEl.style.display = "";
      const mqMobile =
        typeof window !== "undefined" &&
        window.matchMedia(MOBILE_BOOKMARK_MEDIA).matches;
      const nSlots = bookmarkSlotBtns.length;
      const mobileWindow = getMobileBookmarkWindowSize();
      const peekActive = mqMobile && nSlots > mobileWindow;
      if (peekActive) {
        bookmarkSlotsEl.setAttribute("data-mobile-bookmark-peek", "");
        bookmarkSlotsViewport.classList.add("showroom-bookmark-slots-viewport--peek");
      } else {
        bookmarkSlotsEl.removeAttribute("data-mobile-bookmark-peek");
        bookmarkSlotsViewport.classList.remove("showroom-bookmark-slots-viewport--peek");
        bookmarkSlotsEl.style.transform = "";
        bookmarkSlotsViewport.style.width = "";
      }
      for (let i = 0; i < bookmarkSlotBtns.length; i++) {
        const btn = bookmarkSlotBtns[i]!;
        const bmAt = bookmarks[i];
        btn.disabled = !bmAt;
        btn.classList.toggle("selected", i === currentBookmarkIndex);
        const tipShort = bmAt
          ? (BOOKMARK_TOOLTIP_MAP[bmAt.name] ?? bmAt.name)
          : `Vista ${i + 1}`;
        btn.removeAttribute("title");
        btn.setAttribute(
          "aria-label",
          bmAt
            ? `Ir a ${tipShort}: ${bmAt.name}`
            : `${tipShort}, no disponible en este modelo`
        );
      }
      if (peekActive) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const first = bookmarkSlotBtns[0];
            if (!first || !bookmarkSlotsEl.hasAttribute("data-mobile-bookmark-peek")) return;
            const second = bookmarkSlotBtns[1];
            const r0 = first.getBoundingClientRect();
            const stride = second
              ? bookmarkSlotBtns[1]!.getBoundingClientRect().left - r0.left
              : r0.width + 8;
            if (stride <= 0) return;
            const rNow = mobileBookmarkVisibleRange(
              currentBookmarkIndex,
              nSlots,
              mobileWindow
            );
            const off = rNow.start * stride;
            bookmarkSlotsEl.style.transform = `translate3d(${-off}px,0,0)`;
            const innerW = mobileWindow * stride - (stride - r0.width);
            bookmarkSlotsViewport.style.width = `${Math.ceil(Math.max(innerW, r0.width)) + 4}px`;
          });
        });
      }
    } else {
      prevArrow.style.visibility = "hidden";
      nextArrow.style.visibility = "hidden";
      bookmarkSlotsEl.style.display = "none";
      bookmarkSlotsEl.removeAttribute("data-mobile-bookmark-peek");
      bookmarkSlotsViewport.classList.remove("showroom-bookmark-slots-viewport--peek");
      bookmarkSlotsEl.style.transform = "";
      bookmarkSlotsViewport.style.width = "";
    }

    grid.innerHTML = "";
    for (const mm of manifest.models) {
      const card = document.createElement("div");
      card.className =
        "showroom-modal-card" + (mm.id === state.modelId ? " active" : "");

      const thumb = document.createElement("img");
      thumb.className = "showroom-modal-thumb";
      thumb.src = THUMBNAIL_MAP[mm.id] ?? "";
      thumb.alt = mm.name;
      thumb.loading = "lazy";

      const label = document.createElement("div");
      label.className = "showroom-modal-label";
      const nameplateSrc = NAMEPLATE_MAP[mm.id];
      if (nameplateSrc) {
        const plate = document.createElement("img");
        plate.className = "showroom-modal-nameplate";
        plate.src = nameplateSrc;
        plate.alt = mm.name;
        plate.decoding = "async";
        plate.loading = "lazy";
        label.appendChild(plate);
      } else {
        label.classList.add("showroom-modal-label--text");
        label.textContent = DISPLAY_NAMES[mm.id] ?? mm.name.toUpperCase();
      }

      card.appendChild(thumb);
      card.appendChild(label);
      card.addEventListener("click", async () => {
        if (mm.id === stateStore!.getState().modelId) {
          overlay.hidden = true;
          return;
        }
        overlay.hidden = true;
        await handlers.onModelSelect(mm);
      });
      grid.appendChild(card);
    }
  }

  const mqPeek = window.matchMedia(MOBILE_BOOKMARK_MEDIA);
  const onPeekMq = (): void => {
    update();
  };
  mqPeek.addEventListener("change", onPeekMq);

  return { update };
}

async function init(): Promise<void> {
  try {
    manifest = await loadManifest();
  } catch (err) {
    console.error("Failed to load manifest:", err);
    await loadingOverlay.fadeOutEntireAndHide(260);
    return;
  }

  syncViewerSceneLook();

  /**
   * Pull the last-session snapshot so the user lands back where they were
   * after an OOM-induced tab reload or manual refresh. URL params still win
   * (shared deep links stay deterministic) — fallback only fills the slots
   * URL didn't fill.
   */
  const savedView = loadLastView();
  const urlOpts = resolveShowroomUrlParams(
    manifest,
    savedView
      ? { modelId: savedView.modelId, colorId: savedView.colorId }
      : undefined
  );
  urlLoadScope = urlOpts.loadScope;
  hideCarShellGlbWhenDealership = urlOpts.showDealership;

  /**
   * Resolve the bookmark + viewMode to restore. Precedence:
   *   1. `?view=` URL param (when it maps to a real bookmark on this model)
   *   2. Saved last view (only when the restored model matches the saved one)
   *   3. Manifest default view + bookmark 0
   * Picking a different car from URL invalidates the saved bookmark index.
   */
  let initialBookmarkIndex = 0;
  let initialViewMode = manifest.defaults.view;
  if (urlOpts.urlViewExplicit) {
    initialBookmarkIndex = urlOpts.initialBookmarkIndex;
    initialViewMode = urlOpts.viewMode;
  } else if (savedView && savedView.modelId === urlOpts.modelId) {
    const savedModel = manifest.models.find((m) => m.id === urlOpts.modelId);
    const bookmarkCount = savedModel?.cameraBookmarks?.length ?? 0;
    if (
      savedView.bookmarkIndex >= 0 &&
      savedView.bookmarkIndex < bookmarkCount
    ) {
      initialBookmarkIndex = savedView.bookmarkIndex;
    }
    initialViewMode = savedView.viewMode;
  }

  stateStore = new StateStore({
    modelId: urlOpts.modelId,
    colorId: urlOpts.colorId,
    viewMode: initialViewMode,
  });

  showroomUI = buildShowroomUI({
    onModelSelect: handleModelSelectFromModal,
  });

  loadingOverlay.show();
  loadingOverlay.setProgress(0);

  abortController = new AbortController();
  const bootSignal = abortController.signal;

  const bootModel = manifest.models.find((m) => m.id === urlOpts.modelId);

  /**
   * Kick off the boot exterior download via <link rel=preload> the instant
   * we know the URL — runs in parallel with scene bootstrap, so the first
   * paint of the car arrives a full RTT sooner. Spark's later fetch() in
   * AssetManager dedupes against this in-flight request.
   */
  if (bootModel) {
    const bootColor = resolveColorForModel(bootModel, urlOpts.colorId);
    if (bootColor) {
      const ext = bootColor.assets.exterior;
      if (ext) preloadSplat(resolveSplatAssetUrl(resolveAssetUrl(ext, getLOD())));
    }
  }

  try {
    if (bootModel && isPresentationMode(bootModel)) {
      await bootstrapPresentationGate(
        urlOpts.showDealership,
        urlOpts.modelId,
        urlOpts.colorId,
        bootSignal,
        initialBookmarkIndex
      );
    } else {
      await bootstrapNonPresentation(urlOpts.showDealership, bootSignal);
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      console.error("Bootstrap failed:", e);
    }
  } finally {
    // Don't lift the curtain until every UI chrome icon is downloaded + decoded
    // (started at module load, so this has almost always resolved by now).
    await uiIconsReady;
    await loadingOverlay.fadeOutEntireAndHide(400);
    runtime.scheduleSettleRenders();
  }

  // First car (splat + mask + color grade) is presented — warm the model-picker
  // images in the background so the popup opens with everything already cached.
  preloadUiImages();

  if (urlOpts.showBackdrop) {
    await loadBlackdrop();
    await loadChangan3D();
  }

  const state = stateStore.getState();
  const model = manifest.models.find((m) => m.id === state.modelId);
  if (model) {
    annotationSystem.setAnnotations(model.annotations);
    annotationSystem.setViewMode(state.viewMode);
    annotationSystem.setBookmarks(model.bookmarks);
  }

  showroomUI.update();

  const { createChatbotPanel } = await chatbotPanelModulePromise;
  chatbotPanel = createChatbotPanel({
    container: appRoot,
    getModelId: () => stateStore!.getState().modelId,
    getModelDisplayName: () => {
      const id = stateStore!.getState().modelId;
      const m = manifest!.models.find((x) => x.id === id);
      return DISPLAY_NAMES[id] ?? m?.name ?? id;
    },
    onMobileChatPixelReduced: applyViewerPixelRatioForMobileChat,
  });

  // Feedback capture (?test=1) — round photo / video buttons top-left.
  // The captured media is uploaded to R2 and a row is created in the Notion DB.
  if (feedbackCaptureModulePromise) {
    const { createFeedbackCapture } = await feedbackCaptureModulePromise;
    createFeedbackCapture({
      canvas,
      // Force one render so the canvas drawing buffer has fresh pixels —
      // the renderer runs with preserveDrawingBuffer:false for performance.
      triggerRender: () => {
        runtime.requestRender(1);
        runtime.renderer.render(runtime.scene, runtime.camera);
      },
      getCurrentModelId: () => stateStore!.getState().modelId,
      getCurrentColorId: () => stateStore!.getState().colorId,
    });
  }

  stateStore.subscribe(() => {
    bookmarkEnsureGeneration++;
    syncPresentationCacheProtectKeys();
    const st = stateStore!.getState();
    const m = manifest!.models.find((x) => x.id === st.modelId);
    if (m) {
      annotationSystem.setAnnotations(m.annotations);
      annotationSystem.setViewMode(st.viewMode);
      annotationSystem.setBookmarks(m.bookmarks);
    }
    showroomUI?.update();
    chatbotPanel?.updateContext();
    persistCurrentView();
    if (modelSwitchSuppressed) return;
    void loadCurrentAsset();
  });

  /** Initial save so a refresh before any interaction still restores the boot. */
  persistCurrentView();

  syncPresentationCacheProtectKeys();
  runLazyQueue(urlLoadScope, urlOpts.modelId, urlOpts.colorId);

  reapplyOrbitZoomFromActiveBookmark = () => {
    if (!manifest || !stateStore) return;
    if (freeLook.enabled) return;
    if (!runtime.controls.enabled) return;
    const st = stateStore.getState();
    const m = manifest.models.find((x) => x.id === st.modelId);
    if (!m?.cameraBookmarks?.length) return;
    const bm = m.cameraBookmarks[currentBookmarkIndex] ?? m.cameraBookmarks[0];
    if (!bm || bm.cameraMode === "freelook") return;
    applyBookmarkOrbitZoom(bm);
  };
}

init();
runtime.startRenderLoop();
