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
    // While the matcap effect is active the visible material is a swap-in;
    // tint state must live on the ORIGINAL material (the matcap pass mirrors
    // it). See applyNameplateMatcap.
    const target =
      (o.userData._matcapOriginalMaterial as THREE.Material | THREE.Material[] | undefined) ??
      o.material;
    if (Array.isArray(target)) target.forEach(applyOne);
    else applyOne(target);
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
    const src =
      (o.userData._matcapOriginalMaterial as THREE.Material | THREE.Material[] | undefined) ??
      o.material;
    const m = Array.isArray(src) ? src[0] : src;
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

/** Manifest shape for the nameplate matcap effect (see @changan/shared). */
export interface NameplateMatcapOptions {
  enabled?: boolean;
  url?: string;
  brightness?: number;
}

/** Bundled default matcap — shipped in both apps' `public/matcaps/`. */
export const DEFAULT_NAMEPLATE_MATCAP_URL = "/matcaps/metal.png";

const MATCAP_ORIGINAL_KEY = "_matcapOriginalMaterial";

const matcapTextureCache = new Map<string, Promise<THREE.Texture>>();

/** Load (and cache) a matcap texture. Accepts app paths and data URLs. */
export function loadMatcapTexture(url: string): Promise<THREE.Texture> {
  let p = matcapTextureCache.get(url);
  if (!p) {
    p = new THREE.TextureLoader().loadAsync(url).then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    });
    p.catch(() => matcapTextureCache.delete(url));
    matcapTextureCache.set(url, p);
  }
  return p;
}

/**
 * Swap every mesh material under `root` for a MeshMatcapMaterial using
 * `texture` (metallic look independent of scene lights). Pass `null` to
 * restore the original materials. The original material is kept on
 * `mesh.userData` so toggling is lossless; the matcap material's color is
 * the tint system's output (see {@link applyChangan3DTint}) times
 * `brightness`, so tint + matcap compose.
 */
export function applyNameplateMatcap(
  root: THREE.Object3D,
  texture: THREE.Texture | null,
  opts?: { brightness?: number }
): void {
  const b =
    opts?.brightness === undefined || !Number.isFinite(opts.brightness)
      ? 1
      : Math.max(0, Math.min(4, opts.brightness));
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (texture) {
      if (!o.userData[MATCAP_ORIGINAL_KEY]) {
        o.userData[MATCAP_ORIGINAL_KEY] = o.material;
      }
      const original = o.userData[MATCAP_ORIGINAL_KEY] as
        | THREE.Material
        | THREE.Material[];
      const source = Array.isArray(original) ? original[0] : original;
      const srcColor =
        source && "color" in source
          ? (source as THREE.MeshStandardMaterial).color
          : null;
      let mat = o.material as THREE.MeshMatcapMaterial;
      if (!(mat instanceof THREE.MeshMatcapMaterial)) {
        mat = new THREE.MeshMatcapMaterial();
        o.material = mat;
      }
      mat.matcap = texture;
      // Tint chain: the tint system writes to the ORIGINAL material's color
      // (cached base × tint); mirror it here scaled by brightness.
      mat.color.copy(srcColor ?? new THREE.Color(0xffffff)).multiplyScalar(b);
      mat.needsUpdate = true;
    } else if (o.userData[MATCAP_ORIGINAL_KEY]) {
      if (o.material instanceof THREE.MeshMatcapMaterial) o.material.dispose();
      o.material = o.userData[MATCAP_ORIGINAL_KEY] as THREE.Material | THREE.Material[];
      delete o.userData[MATCAP_ORIGINAL_KEY];
    }
  });
}

/**
 * Resolve + apply the matcap effect from manifest options. Default state
 * (no manifest entry) is ENABLED with the bundled metal matcap. Idempotent;
 * call again after tint changes so the matcap color follows.
 */
export async function applyNameplateMatcapFromOptions(
  root: THREE.Object3D,
  matcap: NameplateMatcapOptions | undefined,
  resolveUrl?: (url: string) => string
): Promise<void> {
  const enabled = matcap?.enabled !== false;
  if (!enabled) {
    applyNameplateMatcap(root, null);
    return;
  }
  const rawUrl = matcap?.url || DEFAULT_NAMEPLATE_MATCAP_URL;
  const url =
    rawUrl.startsWith("data:") || !resolveUrl ? rawUrl : resolveUrl(rawUrl);
  try {
    const tex = await loadMatcapTexture(url);
    applyNameplateMatcap(root, tex, { brightness: matcap?.brightness });
  } catch {
    applyNameplateMatcap(root, null);
  }
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
