import * as THREE from "three";
import type { CameraBookmark as CameraBookmarkDef } from "@changan/shared";
import type { PerspectiveCamera } from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

export interface CameraBookmarksOptions {
  camera: PerspectiveCamera;
  controls: OrbitControls;
  duration?: number;
}

export class CameraBookmarksController {
  private camera: PerspectiveCamera;
  private controls: OrbitControls;
  private duration: number;
  private startPos = new THREE.Vector3();
  private startTarget = new THREE.Vector3();
  private endPos = new THREE.Vector3();
  private endTarget = new THREE.Vector3();
  private startTime = 0;
  private rafId: number | null = null;
  private focusActive = false;
  private focusWaiters: Array<() => void> = [];

  constructor({
    camera,
    controls,
    duration = 0.4,
  }: CameraBookmarksOptions) {
    this.camera = camera;
    this.controls = controls;
    this.duration = duration;
  }

  private flushFocusWaiters(): void {
    const w = this.focusWaiters;
    this.focusWaiters = [];
    for (const fn of w) fn();
  }

  /** Resolves when the current focus animation finishes (or immediately if none). */
  waitUntilIdle(): Promise<void> {
    if (!this.focusActive) return Promise.resolve();
    return new Promise((r) => this.focusWaiters.push(r));
  }

  /**
   * Animate camera to bookmark over duration.
   * @param onComplete - Called when animation finishes (e.g. enable free-look / orbit).
   */
  focusBookmark(bookmark: CameraBookmarkDef, onComplete?: () => void): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.focusActive = false;
    this.flushFocusWaiters();

    this.startPos.copy(this.camera.position);
    this.startTarget.copy(this.controls.target);
    this.endPos.set(bookmark.pos[0], bookmark.pos[1], bookmark.pos[2]);
    this.endTarget.set(
      bookmark.target[0],
      bookmark.target[1],
      bookmark.target[2]
    );
    this.startTime = performance.now();
    this.focusActive = true;

    const tick = () => {
      const t = Math.min(
        1,
        (performance.now() - this.startTime) / this.duration
      );
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic

      this.camera.position.lerpVectors(this.startPos, this.endPos, eased);
      this.controls.target.lerpVectors(this.startTarget, this.endTarget, eased);

      if (t < 1) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.rafId = null;
        this.focusActive = false;
        onComplete?.();
        this.flushFocusWaiters();
      }
    };
    tick();
  }

  /**
   * Instantly set camera to bookmark (no animation).
   */
  setBookmarkInstant(bookmark: CameraBookmarkDef): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.focusActive = false;
    this.flushFocusWaiters();
    this.camera.position.set(
      bookmark.pos[0],
      bookmark.pos[1],
      bookmark.pos[2]
    );
    this.controls.target.set(
      bookmark.target[0],
      bookmark.target[1],
      bookmark.target[2]
    );
  }
}
