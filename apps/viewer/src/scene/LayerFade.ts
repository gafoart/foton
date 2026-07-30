import type { SplatMesh } from "@sparkjsdev/spark";
import type { Object3D } from "three";

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface LayerFadeOptions {
  duration?: number;
}

/** First child is the SplatMesh; do not require numeric opacity (Spark may leave it unset until first assign). */
function getSplatMesh(obj: Object3D): SplatMesh | null {
  const child = obj.children[0];
  return child ? (child as SplatMesh) : null;
}

export class LayerFadeAnimation {
  private duration: number;
  private startTime = 0;
  private active = false;
  private onComplete?: () => void;
  private idleWaiters: Array<() => void> = [];
  private layers: Array<{
    mesh: SplatMesh;
    group: Object3D;
    fromOpacity: number;
    toOpacity: number;
    toVisible: boolean;
  }> = [];

  constructor({ duration = 900 }: LayerFadeOptions = {}) {
    this.duration = duration;
  }

  private flushIdleWaiters(): void {
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const fn of w) fn();
  }

  /** Resolves when the current fade finishes (or immediately if none running). */
  waitUntilIdle(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Snap any in-flight fade to its target and drop callbacks (e.g. color change or rapid bookmark taps).
   */
  cancel(): void {
    if (!this.active) {
      this.onComplete = undefined;
      return;
    }
    for (const { mesh, group, toOpacity, toVisible } of this.layers) {
      mesh.opacity = toOpacity;
      group.visible = toVisible;
    }
    this.active = false;
    this.layers = [];
    this.onComplete = undefined;
    this.flushIdleWaiters();
  }

  start(
    layers: Array<{ group: Object3D; fromVisible: boolean; toVisible: boolean }>,
    onComplete?: () => void
  ): void {
    if (this.active) {
      for (const { mesh, group, toOpacity, toVisible } of this.layers) {
        mesh.opacity = toOpacity;
        group.visible = toVisible;
      }
      this.flushIdleWaiters();
    }
    this.onComplete = undefined;
    this.layers = [];
    for (const { group, fromVisible, toVisible } of layers) {
      const mesh = getSplatMesh(group);
      if (mesh) {
        const fromOpacity = fromVisible ? 1 : 0;
        const toOpacity = toVisible ? 1 : 0;
        mesh.opacity = fromOpacity;
        group.visible = true; // visible during fade
        this.layers.push({ mesh, group, fromOpacity, toOpacity, toVisible });
      }
    }
    this.startTime = performance.now();
    this.onComplete = onComplete;
    this.active = this.layers.length > 0;
    if (!this.active) onComplete?.();
  }

  update(): boolean {
    if (!this.active) return false;
    const elapsed = performance.now() - this.startTime;
    const t = Math.min(elapsed / this.duration, 1);
    const eased = easeInOutCubic(t);

    for (const { mesh, group, fromOpacity, toOpacity, toVisible } of this.layers) {
      mesh.opacity = fromOpacity + (toOpacity - fromOpacity) * eased;
    }

    if (t >= 1) {
      for (const { mesh, group, toOpacity, toVisible } of this.layers) {
        mesh.opacity = toOpacity;
        group.visible = toVisible;
      }
      this.active = false;
      this.onComplete?.();
      this.onComplete = undefined;
      this.flushIdleWaiters();
      return false;
    }
    return true;
  }
}
