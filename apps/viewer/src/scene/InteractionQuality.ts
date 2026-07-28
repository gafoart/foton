import { SplatMesh } from "@sparkjsdev/spark";
import type { SceneRuntime } from "@changan/scene-runtime";
import type { QualityProfile } from "./LODSelector.js";

export interface InteractionQualityOptions {
  runtime: SceneRuntime;
  profile: QualityProfile;
  container: HTMLElement;
  restoreDelay?: number;
}

export class InteractionQualityController {
  private runtime: SceneRuntime;
  private profile: QualityProfile;
  private container: HTMLElement;
  private restoreDelay: number;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private reduced = false;

  constructor({ runtime, profile, container, restoreDelay = 250 }: InteractionQualityOptions) {
    this.runtime = runtime;
    this.profile = profile;
    this.container = container;
    this.restoreDelay = restoreDelay;
  }

  onInteractionStart(): void {
    if (this.restoreTimer !== null) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    if (this.reduced) return;
    this.reduced = true;

    this.runtime.renderer.setPixelRatio(this.profile.interactionPixelRatio);
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.runtime.renderer.setSize(w, h);

    this.forEachSplatMesh((mesh) => {
      mesh.maxSh = this.profile.interactionMaxSh;
      mesh.updateGenerator();
    });
  }

  onInteractionEnd(): void {
    if (this.restoreTimer !== null) clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      if (!this.reduced) return;
      this.reduced = false;

      this.runtime.renderer.setPixelRatio(this.profile.pixelRatio);
      const w = this.container.clientWidth || window.innerWidth;
      const h = this.container.clientHeight || window.innerHeight;
      this.runtime.renderer.setSize(w, h);

      this.forEachSplatMesh((mesh) => {
        mesh.maxSh = this.profile.maxSh;
        mesh.updateGenerator();
      });

      this.runtime.scheduleSettleRenders();
    }, this.restoreDelay);
  }

  private forEachSplatMesh(fn: (mesh: SplatMesh) => void): void {
    this.runtime.getSplatContainer().traverse((child) => {
      if (child instanceof SplatMesh) fn(child);
    });
  }
}
