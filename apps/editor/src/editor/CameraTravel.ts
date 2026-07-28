import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** Ease-in-out cubic for smooth start and end */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface CameraTravelState {
  pos: [number, number, number];
  target: [number, number, number];
  onComplete?: () => void;
}

export interface CameraTravelOptions {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  duration?: number; // ms, default 800
}

/**
 * Animates the camera from its current position/target to the given destination.
 * Call update() each frame (e.g. in onTick) until it returns false.
 */
export class CameraTravelAnimation {
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private duration: number;

  private startPos = new THREE.Vector3();
  private startTarget = new THREE.Vector3();
  private endPos = new THREE.Vector3();
  private endTarget = new THREE.Vector3();
  private startTime = 0;
  private active = false;
  private onComplete?: () => void;

  constructor({ camera, controls, duration = 800 }: CameraTravelOptions) {
    this.camera = camera;
    this.controls = controls;
    this.duration = duration;
  }

  /** Start traveling to the given position and target. Calls onComplete when done. */
  start(to: CameraTravelState): void {
    this.startPos.copy(this.camera.position);
    this.startTarget.copy(this.controls.target);
    this.endPos.set(to.pos[0], to.pos[1], to.pos[2]);
    this.endTarget.set(to.target[0], to.target[1], to.target[2]);
    this.startTime = performance.now();
    this.onComplete = to.onComplete;
    this.active = true;
  }

  /** Call each frame. Returns true while animation is running. */
  update(): boolean {
    if (!this.active) return false;
    const elapsed = performance.now() - this.startTime;
    const t = Math.min(elapsed / this.duration, 1);
    const eased = easeInOutCubic(t);

    this.camera.position.lerpVectors(this.startPos, this.endPos, eased);
    this.controls.target.lerpVectors(this.startTarget, this.endTarget, eased);

    if (t >= 1) {
      this.camera.position.copy(this.endPos);
      this.controls.target.copy(this.endTarget);
      this.active = false;
      this.onComplete?.();
      this.onComplete = undefined;
      return false;
    }
    return true;
  }

  get isActive(): boolean {
    return this.active;
  }
}
