import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

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
  duration?: number;
}

export class CameraTravelAnimation {
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private duration: number;
  private startPos = new THREE.Vector3();
  private startTarget = new THREE.Vector3();
  private endPos = new THREE.Vector3();
  private endTarget = new THREE.Vector3();
  private startQuat = new THREE.Quaternion();
  private endQuat = new THREE.Quaternion();
  private _lookAtMat = new THREE.Matrix4();
  private startTime = 0;
  private active = false;
  private onComplete?: () => void;
  private idleWaiters: Array<() => void> = [];

  constructor({ camera, controls, duration = 900 }: CameraTravelOptions) {
    this.camera = camera;
    this.controls = controls;
    this.duration = duration;
  }

  private flushIdleWaiters(): void {
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const fn of w) fn();
  }

  /** Resolves when the current travel finishes (or immediately if none running). */
  waitUntilIdle(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  isActive(): boolean {
    return this.active;
  }

  start(to: CameraTravelState): void {
    if (this.active) {
      const oc = this.onComplete;
      this.onComplete = undefined;
      oc?.();
      this.flushIdleWaiters();
    }
    this.startPos.copy(this.camera.position);
    this.startTarget.copy(this.controls.target);
    this.startQuat.copy(this.camera.quaternion);
    this.endPos.set(to.pos[0], to.pos[1], to.pos[2]);
    this.endTarget.set(to.target[0], to.target[1], to.target[2]);
    /**
     * Precompute the destination orientation as a quaternion so we can slerp
     * directly from the current orientation to it. Lerping `controls.target`
     * and letting `OrbitControls.update()` derive orientation via lookAt
     * leaves the camera looking at an interpolated point that is geometrically
     * far from the freelook gaze until the very last frame — the visible
     * symptom was "interior splat seen from outside" mid-flight. Matrix4.lookAt
     * uses the camera convention (-Z toward target), so the resulting
     * quaternion matches what OrbitControls/lookAt would produce at the end.
     */
    this._lookAtMat.lookAt(this.endPos, this.endTarget, this.camera.up);
    this.endQuat.setFromRotationMatrix(this._lookAtMat);
    this.startTime = performance.now();
    this.onComplete = to.onComplete;
    this.active = true;
  }

  update(): boolean {
    if (!this.active) return false;
    const elapsed = performance.now() - this.startTime;
    const t = Math.min(elapsed / this.duration, 1);
    const eased = easeInOutCubic(t);
    this.camera.position.lerpVectors(this.startPos, this.endPos, eased);
    this.camera.quaternion.slerpQuaternions(this.startQuat, this.endQuat, eased);
    /**
     * Keep `controls.target` lerping so OrbitControls' internal spherical
     * state is consistent at handoff (orbit destinations re-seed it on the
     * first post-travel update). Caller skips controls.update() while
     * isActive() so this lerped target does NOT drive orientation during
     * the flight — the slerped quaternion does.
     */
    this.controls.target.lerpVectors(this.startTarget, this.endTarget, eased);
    if (t >= 1) {
      this.camera.position.copy(this.endPos);
      this.camera.quaternion.copy(this.endQuat);
      this.controls.target.copy(this.endTarget);
      this.active = false;
      this.onComplete?.();
      this.onComplete = undefined;
      this.flushIdleWaiters();
      return false;
    }
    return true;
  }
}
