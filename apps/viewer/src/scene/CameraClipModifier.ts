import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import { dyno } from "@sparkjsdev/spark";

/**
 * Per-Gaussian camera-distance clip. Splats whose world-space center sits
 * within `clipNear` of the camera are fully invisible, fading up to full
 * opacity by `clipFar`. Avoids the "column-in-the-face" symptom when the
 * orbit camera sweeps past dealership pillars / walls.
 *
 * Implemented as a Spark `worldModifier` on the SplatMesh — does NOT touch
 * geometry / sort / packed splat data, just multiplies the runtime opacity.
 */

type ClipBlock = ReturnType<typeof buildModifier>;

declare global {
  // eslint-disable-next-line no-var
  var __camclip: CameraClipConsoleApi | undefined;
}

interface CameraClipConsoleApi {
  setNear(v: number): void;
  setFar(v: number): void;
  enable(on?: boolean): void;
  status(): void;
}

function buildModifier(
  uViewPos: ReturnType<typeof dyno.dynoVec3<THREE.Vector3>>,
  uClipNear: ReturnType<typeof dyno.dynoFloat>,
  uClipFar: ReturnType<typeof dyno.dynoFloat>
) {
  return dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      if (!gsplat) throw new Error("camera-clip: gsplat missing");
      const parts = dyno.splitGsplat(gsplat).outputs;
      const center = parts.center;
      const opacity = parts.opacity;
      const dist = dyno.length(dyno.sub(center, uViewPos));
      // 0 inside near, 1 outside far — smoothstep gives a soft edge so splats
      // don't pop in/out as the camera crosses the boundary.
      const visibility = dyno.smoothstep(uClipNear, uClipFar, dist);
      const newOpacity = dyno.mul(opacity, visibility);
      return {
        gsplat: dyno.combineGsplat({ gsplat, opacity: newOpacity }),
      };
    },
    { globals: () => [dyno.defineGsplat] }
  );
}

export interface CameraClipOptions {
  near?: number;
  far?: number;
}

export class CameraClipController {
  private uViewPos: ReturnType<typeof dyno.dynoVec3<THREE.Vector3>>;
  private uClipNear: ReturnType<typeof dyno.dynoFloat>;
  private uClipFar: ReturnType<typeof dyno.dynoFloat>;
  private modifier: ClipBlock;
  private applied: SplatMesh[] = [];
  private enabled = true;

  constructor(opts: CameraClipOptions = {}) {
    this.uViewPos = dyno.dynoVec3(new THREE.Vector3(), "camClip_viewPos");
    this.uClipNear = dyno.dynoFloat(opts.near ?? 0.6, "camClip_near");
    this.uClipFar = dyno.dynoFloat(opts.far ?? 1.4, "camClip_far");
    this.modifier = buildModifier(this.uViewPos, this.uClipNear, this.uClipFar);
  }

  attachTo(mesh: SplatMesh): void {
    if (this.applied.includes(mesh)) return;
    if (this.enabled) {
      mesh.worldModifier = this.modifier;
      mesh.updateGenerator();
      mesh.updateVersion();
    }
    this.applied.push(mesh);
  }

  detachFrom(mesh: SplatMesh): void {
    const idx = this.applied.indexOf(mesh);
    if (idx === -1) return;
    this.applied.splice(idx, 1);
    mesh.worldModifier = undefined;
    mesh.updateGenerator();
    mesh.updateVersion();
  }

  /** Call from the render loop, before render. */
  updateView(camera: THREE.Camera): void {
    this.uViewPos.value.copy(camera.position);
  }

  setNear(v: number): void {
    this.uClipNear.value = Math.max(0, v);
    this.bumpAll();
  }

  setFar(v: number): void {
    this.uClipFar.value = Math.max(this.uClipNear.value + 0.001, v);
    this.bumpAll();
  }

  enable(on = true): void {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const mesh of this.applied) {
      mesh.worldModifier = on ? this.modifier : undefined;
      mesh.updateGenerator();
      mesh.updateVersion();
    }
  }

  status(): void {
    // eslint-disable-next-line no-console
    console.log("[camclip]", {
      enabled: this.enabled,
      attached: this.applied.length,
      near: this.uClipNear.value,
      far: this.uClipFar.value,
    });
  }

  private bumpAll(): void {
    for (const mesh of this.applied) mesh.updateVersion();
  }

  /** One-time install of `window.__camclip` console helper + usage banner. */
  installConsoleHooks(): void {
    if (typeof window === "undefined") return;
    if (globalThis.__camclip) return;
    const api: CameraClipConsoleApi = {
      setNear: (v) => this.setNear(v),
      setFar: (v) => this.setFar(v),
      enable: (on = true) => this.enable(on),
      status: () => this.status(),
    };
    globalThis.__camclip = api;
    // eslint-disable-next-line no-console
    console.log(
      "%c[camclip] camera-distance splat clip ready",
      "color:#9cf;font-weight:bold",
      "\n  __camclip.setNear(meters)   // splats inside this radius are invisible",
      "\n  __camclip.setFar(meters)    // splats outside this radius are full opacity",
      "\n  __camclip.enable(false)     // toggle off",
      "\n  __camclip.status()"
    );
  }
}
