import * as THREE from "three";
import {
  resolveContactShadowGradient,
  resolveContactShadowCornerRadius,
  type ContactShadowGradientResolved,
} from "@changan/shared";

const TEX_SIZE = 256;

/** Local half-extents of the floor blob in X / Z (before group scale). */
const LOCAL_HALF_W = 1;
const LOCAL_HALF_D = 1;

function paintRadialAlphaTexture(
  texture: THREE.CanvasTexture,
  g: ContactShadowGradientResolved
): void {
  const canvas = texture.image as HTMLCanvasElement;
  const size = canvas.width;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("createContactShadowDisk: 2d context unavailable");
  }
  const cx = size / 2;
  const r = size / 2 - 0.5;
  ctx.clearRect(0, 0, size, size);
  const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, r);
  grad.addColorStop(0, `rgba(0,0,0,${g.centerAlpha})`);
  grad.addColorStop(g.midStop, `rgba(0,0,0,${g.midAlpha})`);
  grad.addColorStop(1, `rgba(0,0,0,${g.edgeAlpha})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  texture.needsUpdate = true;
}

function createRoundedRectShapeGeometry(hw: number, hd: number, cornerR: number): THREE.ShapeGeometry {
  const r = Math.min(Math.max(0, cornerR), hw, hd);
  const x = -hw;
  const y = -hd;
  const w = hw * 2;
  const h = hd * 2;
  const shape = new THREE.Shape();
  if (r < 1e-5) {
    shape.moveTo(x, y);
    shape.lineTo(x + w, y);
    shape.lineTo(x + w, y + h);
    shape.lineTo(x, y + h);
    shape.closePath();
  } else {
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
    shape.lineTo(x + w, y + h - r);
    shape.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
    shape.lineTo(x + r, y + h);
    shape.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
    shape.lineTo(x, y + r);
    shape.absarc(x + r, y + r, r, Math.PI, 1.5 * Math.PI, false);
  }
  return new THREE.ShapeGeometry(shape, 36);
}

export interface ContactShadowDiskResult {
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  texture: THREE.CanvasTexture;
  /** Re-paints the radial map from manifest gradient fields (no-op if unchanged). */
  applyResolvedGradient: (g: ContactShadowGradientResolved) => void;
  /** `cornerRadius` manifest 0–1 → local arc radius (rebuilds geometry if changed). */
  setCornerRadiusT: (manifestCorner01?: number) => void;
  dispose: () => void;
}

/**
 * Horizontal soft shadow: rounded rectangle in XZ (unit half-size 1×1); scale group for footprint.
 * Renders before splats (negative renderOrder) so 3DGS draws on top.
 */
export function createContactShadowDiskGroup(opacity = 0.92): ContactShadowDiskResult {
  const canvas = document.createElement("canvas");
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  let lastGradientKey = "";
  const applyResolvedGradient = (g: ContactShadowGradientResolved): void => {
    const key = `${g.centerAlpha},${g.midStop},${g.midAlpha},${g.edgeAlpha}`;
    if (key === lastGradientKey) return;
    lastGradientKey = key;
    paintRadialAlphaTexture(texture, g);
  };

  applyResolvedGradient(resolveContactShadowGradient(undefined));

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    blending: THREE.NormalBlending,
    polygonOffset: false,
  });

  const t0 = resolveContactShadowCornerRadius(undefined);
  const r0 = t0 * Math.min(LOCAL_HALF_W, LOCAL_HALF_D);
  let lastCornerKey = String(r0);
  const geo0 = createRoundedRectShapeGeometry(LOCAL_HALF_W, LOCAL_HALF_D, r0);

  const mesh = new THREE.Mesh(geo0, material);

  const setCornerRadiusT = (manifestCorner01?: number): void => {
    const t = resolveContactShadowCornerRadius(manifestCorner01);
    const rLocal = t * Math.min(LOCAL_HALF_W, LOCAL_HALF_D);
    const key = String(rLocal);
    if (key === lastCornerKey) return;
    lastCornerKey = key;
    const newGeo = createRoundedRectShapeGeometry(LOCAL_HALF_W, LOCAL_HALF_D, rLocal);
    mesh.geometry.dispose();
    mesh.geometry = newGeo;
  };

  mesh.rotation.x = -Math.PI / 2;
  /** Below Spark splats (default 0); above car GLB shell (typically -50). */
  mesh.renderOrder = -40;
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.name = "ContactShadow";
  group.userData.isContactShadow = true;
  group.add(mesh);
  return {
    group,
    mesh,
    material,
    texture,
    applyResolvedGradient,
    setCornerRadiusT,
    dispose: () => {
      mesh.geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
