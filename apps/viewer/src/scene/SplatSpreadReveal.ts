import type { Object3D } from "three";
import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import { dyno } from "@sparkjsdev/spark";

let revealUniformKey = 0;

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

function getSplatMesh(obj: Object3D): SplatMesh | null {
  const child = obj.children[0];
  return child ? (child as SplatMesh) : null;
}

/** Per-Gaussian stagger from object-space XZ radius (no center offset — model stays put). */
function createSpreadRevealModifier(revealT: InstanceType<typeof dyno.DynoFloat>) {
  const f0 = dyno.dynoConst("float", 0);
  const f1 = dyno.dynoConst("float", 1);
  const overlap = dyno.dynoConst("float", 0.55);
  const radiusK = dyno.dynoConst("float", 0.32);
  const tiny = dyno.dynoConst("vec3", new THREE.Vector3(1e-4, 1e-4, 1e-4));
  const grayRgb = dyno.dynoConst("vec3", new THREE.Vector3(0.3, 0.3, 0.3));

  return dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      if (!gsplat) throw new Error("spread reveal: gsplat missing");
      const o = dyno.splitGsplat(gsplat).outputs;
      const center = o.center;
      const scales = o.scales;
      const opacity = o.opacity;
      const rgb = o.rgb;
      const cxz = dyno.combine({
        vectorType: "vec2",
        x: dyno.split(center).outputs.x,
        y: dyno.split(center).outputs.z,
      });
      const l = dyno.clamp(dyno.mul(dyno.length(cxz), radiusK), f0, f1);
      const tScaled = dyno.mul(revealT, dyno.add(f1, overlap));
      const wave = dyno.clamp(dyno.sub(tScaled, dyno.mul(l, overlap)), f0, f1);
      const newScales = dyno.mix(tiny, scales, wave);
      const newRgb = dyno.mix(grayRgb, rgb, wave);
      const newOpacity = dyno.mul(opacity, wave);
      return {
        gsplat: dyno.combineGsplat({
          gsplat,
          scales: newScales,
          rgb: newRgb,
          opacity: newOpacity,
        }),
      };
    },
    { globals: () => [dyno.defineGsplat] }
  );
}

/** Exported for showroom bookmark visibility — stale modifiers can zero-out splats while opacity stays 1. */
export function stripRevealModifier(mesh: SplatMesh): void {
  mesh.objectModifier = undefined;
  mesh.updateGenerator();
  mesh.updateVersion();
}

export interface SplatSpreadRevealOptions {
  duration?: number;
  /** @deprecated No longer used; reveal is shader-only (no group scale). */
  fromFactor?: number;
  onComplete?: () => void;
}

/**
 * Layered “spread” reveal: splats pop from near-zero scale and gray while staying in place.
 * Uses Spark `objectModifier`; bookmark motor↔interior still uses LayerFade.
 */
export class SplatSpreadRevealAnimation {
  private duration: number;
  private startTime = 0;
  private active = false;
  private onComplete?: () => void;
  private revealT: InstanceType<typeof dyno.DynoFloat> | null = null;
  private modifier: ReturnType<typeof createSpreadRevealModifier> | null = null;
  private entries: Array<{ group: THREE.Object3D; mesh: SplatMesh }> = [];

  constructor({ duration = 780 }: { duration?: number; fromFactor?: number } = {}) {
    this.duration = duration;
  }

  private finish(): void {
    for (const { mesh } of this.entries) {
      stripRevealModifier(mesh);
      mesh.opacity = 1;
    }
    this.entries = [];
    this.revealT = null;
    this.modifier = null;
    this.active = false;
    this.onComplete?.();
    this.onComplete = undefined;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Stop reveal without calling onComplete (caller will re-apply bookmark visibility). */
  cancel(): void {
    if (this.active) {
      for (const { mesh } of this.entries) {
        stripRevealModifier(mesh);
        mesh.opacity = 1;
      }
    }
    this.entries = [];
    this.revealT = null;
    this.modifier = null;
    this.active = false;
    this.onComplete = undefined;
  }

  start(groups: THREE.Object3D[], opts?: SplatSpreadRevealOptions): void {
    if (this.active) {
      for (const { mesh } of this.entries) {
        stripRevealModifier(mesh);
        mesh.opacity = 1;
      }
    }

    const duration = opts?.duration ?? this.duration;
    this.duration = duration;

    this.entries = [];
    this.revealT = new dyno.DynoFloat({
      key: `showroomSpreadReveal_${++revealUniformKey}`,
      value: 0,
    });
    this.modifier = createSpreadRevealModifier(this.revealT);

    for (const group of groups) {
      const mesh = getSplatMesh(group);
      if (!mesh) continue;
      group.visible = true;
      mesh.opacity = 1;
      mesh.objectModifier = this.modifier;
      mesh.updateGenerator();
      mesh.updateVersion();
      this.entries.push({ group, mesh });
    }

    this.startTime = performance.now();
    this.onComplete = opts?.onComplete;
    this.active = this.entries.length > 0;
    if (!this.active) {
      this.revealT = null;
      this.modifier = null;
      opts?.onComplete?.();
    }
  }

  update(): void {
    if (!this.active || !this.revealT) return;
    const elapsed = performance.now() - this.startTime;
    const t = Math.min(elapsed / this.duration, 1);
    this.revealT.value = easeOutQuart(t);

    for (const { mesh } of this.entries) {
      mesh.updateVersion();
    }

    if (t >= 1) {
      this.finish();
    }
  }
}
