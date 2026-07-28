import * as THREE from "three";

/** Clear color / canvas background when no scene.background texture. */
export const DEFAULT_SCENE_BACKGROUND_HEX = "#0a0a0a";

export function parseHexColor(hex: string | undefined, fallbackHex: string): number {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return parseInt(fallbackHex.slice(1), 16);
  }
  return parseInt(hex.slice(1), 16);
}

export interface SceneFogOptions {
  enabled?: boolean;
  color?: string;
  near?: number;
  far?: number;
}

export interface SceneLightingOptions {
  ambient?: { color?: string; intensity?: number };
  directional?: {
    color?: string;
    intensity?: number;
    pos?: [number, number, number];
  };
  fog?: SceneFogOptions | null;
}

export interface ManagedSceneLights {
  ambient: THREE.AmbientLight;
  directional: THREE.DirectionalLight;
}

export function createManagedSceneLights(scene: THREE.Scene): ManagedSceneLights {
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  const directional = new THREE.DirectionalLight(0xffffff, 0.9);
  directional.position.set(6, 12, 8);
  scene.add(ambient, directional);
  return { ambient, directional };
}

export function applySceneBackground(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  backgroundColorHex: string | undefined
): void {
  const n = parseHexColor(backgroundColorHex, DEFAULT_SCENE_BACKGROUND_HEX);
  renderer.setClearColor(n, 1);
  scene.background = new THREE.Color(n);
}

export function applyManagedSceneLighting(
  lights: ManagedSceneLights,
  lighting: SceneLightingOptions | undefined
): void {
  const amb = lighting?.ambient;
  lights.ambient.color.set(amb?.color ?? "#ffffff");
  lights.ambient.intensity = amb?.intensity ?? 0.4;

  const dir = lighting?.directional;
  lights.directional.color.set(dir?.color ?? "#ffffff");
  lights.directional.intensity = dir?.intensity ?? 0.9;
  const p = dir?.pos ?? [6, 12, 8];
  lights.directional.position.set(p[0], p[1], p[2]);
}

/**
 * Distance fog softens the backdrop (depth haze). Disabled when `enabled` is false or omitted.
 */
export function applySceneFog(scene: THREE.Scene, fog: SceneFogOptions | undefined | null): void {
  if (fog == null || fog.enabled !== true) {
    scene.fog = null;
    return;
  }
  const near = fog.near ?? 5;
  const far = fog.far ?? 50;
  if (!Number.isFinite(near) || !Number.isFinite(far) || far <= near) {
    scene.fog = null;
    return;
  }
  const c = parseHexColor(fog.color, DEFAULT_SCENE_BACKGROUND_HEX);
  scene.fog = new THREE.Fog(c, near, far);
}

/**
 * Tint GLB backdrop meshes by lerping base albedo toward a color (strength 0..1).
 */
export function applyBlackdropTint(
  root: THREE.Object3D,
  tintHex: string | undefined,
  strength: number | undefined
): void {
  const s = Math.min(1, Math.max(0, strength ?? 0));
  const tint = new THREE.Color(0xffffff);
  if (tintHex && /^#[0-9a-fA-F]{6}$/.test(tintHex)) {
    tint.setStyle(tintHex);
  }

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const applyOne = (m: THREE.Material) => {
      if (!("color" in m)) return;
      const mm = m as THREE.MeshStandardMaterial;
      if (!mm.color) return;
      if (!mm.userData._blackdropBaseColor) {
        mm.userData._blackdropBaseColor = mm.color.clone();
      }
      const base = mm.userData._blackdropBaseColor as THREE.Color;
      mm.color.copy(base);
      if (s > 0) {
        const tinted = base.clone().multiply(tint);
        mm.color.lerp(tinted, s);
      }
    };
    if (Array.isArray(o.material)) o.material.forEach(applyOne);
    else applyOne(o.material);
  });
}

/**
 * Factor applied to each 3D nameplate material's base albedo when no explicit
 * tint is set — i.e. the nameplates render 15% lighter than the GLB ships.
 */
export const CHANGAN3D_DEFAULT_LIGHTEN = 1.15;

const CHANGAN3D_BASE_KEY = "_changan3dBaseColor";

/**
 * Color the changan3D ("nameplates") GLB meshes. With an explicit `tintHex`,
 * every mesh is painted that absolute color. Without one, each mesh keeps its
 * own base albedo brightened by {@link CHANGAN3D_DEFAULT_LIGHTEN} (15% lighter).
 * The base color is cached per material so re-applies stay idempotent.
 */
export function applyChangan3DTint(
  root: THREE.Object3D,
  tintHex: string | undefined
): void {
  const hasTint = !!tintHex && /^#[0-9a-fA-F]{6}$/.test(tintHex);
  const tint = new THREE.Color(0xffffff);
  if (hasTint) tint.setStyle(tintHex!);

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const applyOne = (m: THREE.Material) => {
      if (!("color" in m)) return;
      const mm = m as THREE.MeshStandardMaterial;
      if (!mm.color) return;
      if (!mm.userData[CHANGAN3D_BASE_KEY]) {
        mm.userData[CHANGAN3D_BASE_KEY] = mm.color.clone();
      }
      const base = mm.userData[CHANGAN3D_BASE_KEY] as THREE.Color;
      if (hasTint) {
        mm.color.copy(tint);
      } else {
        mm.color.copy(base).multiplyScalar(CHANGAN3D_DEFAULT_LIGHTEN);
      }
    };
    if (Array.isArray(o.material)) o.material.forEach(applyOne);
    else applyOne(o.material);
  });
}

/**
 * The effective default nameplate color (base albedo × 15%) as a `#rrggbb`
 * hex, read back from the first cached material so the editor's color picker
 * can seed itself to what's actually on screen. Returns null until the GLB has
 * been through {@link applyChangan3DTint} at least once. Channels are clamped.
 */
export function readChangan3DDefaultTintHex(
  root: THREE.Object3D
): string | null {
  let hex: string | null = null;
  root.traverse((o) => {
    if (hex || !(o instanceof THREE.Mesh)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const mm = m as THREE.MeshStandardMaterial | undefined;
    const base = (mm?.userData?.[CHANGAN3D_BASE_KEY] as THREE.Color) ?? mm?.color;
    if (!base) return;
    const c = base.clone().multiplyScalar(CHANGAN3D_DEFAULT_LIGHTEN);
    c.r = Math.min(1, c.r);
    c.g = Math.min(1, c.g);
    c.b = Math.min(1, c.b);
    hex = `#${c.getHexString()}`;
  });
  return hex;
}

/**
 * Scale mesh albedo toward black/white by a brightness factor (default 1).
 * Captures each material’s original color on first visit under `baseUserDataKey`.
 */
function applyMeshAlbedoBrightness(
  root: THREE.Object3D,
  brightness: number | undefined,
  baseUserDataKey: string
): void {
  const b =
    brightness === undefined || !Number.isFinite(brightness)
      ? 1
      : Math.max(0, Math.min(4, brightness));
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const applyOne = (m: THREE.Material) => {
      if (!("color" in m)) return;
      const mm = m as THREE.MeshStandardMaterial;
      if (!mm.color) return;
      if (!mm.userData[baseUserDataKey]) {
        mm.userData[baseUserDataKey] = mm.color.clone();
      }
      const base = mm.userData[baseUserDataKey] as THREE.Color;
      mm.color.copy(base).multiplyScalar(b);
    };
    if (Array.isArray(o.material)) o.material.forEach(applyOne);
    else applyOne(o.material);
  });
}

const FLOOR_BRIGHTNESS_BASE_KEY = "_floorBaseColor";
const CEILING_BRIGHTNESS_BASE_KEY = "_ceilingBaseColor";

export function applyFloorBrightness(
  root: THREE.Object3D,
  brightness: number | undefined
): void {
  applyMeshAlbedoBrightness(root, brightness, FLOOR_BRIGHTNESS_BASE_KEY);
}

/** Same rules as {@link applyFloorBrightness} for dealership ceiling GLBs. */
export function applyCeilingBrightness(
  root: THREE.Object3D,
  brightness: number | undefined
): void {
  applyMeshAlbedoBrightness(root, brightness, CEILING_BRIGHTNESS_BASE_KEY);
}
