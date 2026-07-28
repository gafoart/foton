import * as THREE from "three";

const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _worldUp = new THREE.Vector3(0, 1, 0);
const _worldX = new THREE.Vector3(1, 0, 0);
const _qYaw = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const _lookMat = new THREE.Matrix4();

const _FWD = new THREE.Vector3(0, 0, -1);

const PITCH_LIMIT = Math.PI / 2 - 0.001;
/** Total drag distance (px) before deciding which axis the gesture is on. */
const AXIS_LOCK_THRESHOLD_PX = 4;
/** Set window.__freelookDebug = true in DevTools to trace external camera mutations. */
function isFreelookDebug(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    (globalThis as unknown as { __freelookDebug?: boolean }).__freelookDebug === true
  );
}

/**
 * Fixed eye position: drag to yaw (world Y) or pitch (camera right). No translation, no roll.
 *
 * Orientation is computed from two scalars (yaw, pitch) — never composed by accumulating
 * quaternions — so repeated yaw+pitch gestures cannot introduce Z-roll drift.
 *
 * Per drag, the dominant axis is locked once the cursor crosses AXIS_LOCK_THRESHOLD_PX, and
 * the off-axis component is ignored until pointerup. Diagonal drags become the axis the user
 * started moving on.
 */
export class FreeLookController {
  readonly lockedPosition = new THREE.Vector3();
  private _lockX = 0;
  private _lockY = 0;
  private _lockZ = 0;

  /** Yaw around world +Y. */
  private yaw = 0;
  /** Pitch around local +X (after yaw). Clamped to (−π/2, π/2). */
  private pitch = 0;
  private readonly orientation = new THREE.Quaternion();

  private constrainAngles = false;
  private yawMin = -Infinity;
  private yawMax = Infinity;
  private pitchMin = -PITCH_LIMIT;
  private pitchMax = PITCH_LIMIT;

  private dragging = false;
  private activePointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private dragAxis: "yaw" | "pitch" | null = null;
  private accumDx = 0;
  private accumDy = 0;

  private readonly rotateSpeed: number;
  private readonly onAfterLookChange?: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;

  enabled = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly domElement: HTMLElement,
    options?: { rotateSpeed?: number; onAfterLookChange?: () => void }
  ) {
    this.rotateSpeed = options?.rotateSpeed ?? 0.0025;
    this.onAfterLookChange = options?.onAfterLookChange;
    this.recomputeOrientation();
    const cap = { capture: true } as const;
    this.domElement.addEventListener("pointerdown", this.onPointerDown, cap);
    this.domElement.addEventListener("pointermove", this.onPointerMove, cap);
    this.domElement.addEventListener("pointerup", this.onPointerUp, cap);
    this.domElement.addEventListener("pointercancel", this.onPointerUp, cap);
  }

  clearBookmarkAngleLimits(): void {
    this.constrainAngles = false;
    this.yawMin = -Infinity;
    this.yawMax = Infinity;
    this.pitchMin = -PITCH_LIMIT;
    this.pitchMax = PITCH_LIMIT;
  }

  setAngleLimitsRad(
    minAzimuth: number,
    maxAzimuth: number,
    minPolar: number,
    maxPolar: number
  ): void {
    this.constrainAngles = true;
    let y0 = minAzimuth;
    let y1 = maxAzimuth;
    if (y0 > y1) [y0, y1] = [y1, y0];
    this.yawMin = y0;
    this.yawMax = y1;

    let pMin = Math.PI / 2 - maxPolar;
    let pMax = Math.PI / 2 - minPolar;
    if (pMin > pMax) [pMin, pMax] = [pMax, pMin];
    this.pitchMin = Math.max(pMin, -PITCH_LIMIT);
    this.pitchMax = Math.min(pMax, PITCH_LIMIT);
  }

  isDragging(): boolean {
    return this.dragging;
  }

  setFromBookmark(
    pos: [number, number, number],
    target: [number, number, number]
  ): void {
    this._lockX = pos[0];
    this._lockY = pos[1];
    this._lockZ = pos[2];
    this.lockedPosition.set(pos[0], pos[1], pos[2]);
    _target.set(target[0], target[1], target[2]);
    _lookMat.lookAt(this.lockedPosition, _target, _worldUp);
    _euler.setFromRotationMatrix(_lookMat, "YXZ");
    // Discard any roll (_euler.z); freelook never rolls.
    this.yaw = _euler.y;
    this.pitch = _euler.x;
    this.clampAngles();
    this.recomputeOrientation();
    this.applyPose();
    if (isFreelookDebug()) {
      console.log("[freelook] setFromBookmark", { pos, target, yaw: this.yaw, pitch: this.pitch });
    }
  }

  maintain(): void {
    if (!this.enabled) return;
    if (isFreelookDebug()) {
      const q = this.camera.quaternion;
      const p = this.camera.position;
      if (
        this._lastApplyQx !== q.x || this._lastApplyQy !== q.y ||
        this._lastApplyQz !== q.z || this._lastApplyQw !== q.w ||
        this._lastApplyPx !== p.x || this._lastApplyPy !== p.y ||
        this._lastApplyPz !== p.z
      ) {
        if (this._haveLastApply) {
          /**
           * Quaternion/position differs from what THIS controller last wrote
           * via applyPose. lastApply was set inside applyPose (pointermove or
           * maintain), so any divergence at the START of the next maintain is
           * code OUTSIDE FreeLookController writing the camera between frames.
           * That is what produces the vibration symptom.
           */
          console.log("[freelook] camera mutated by external code between applies", {
            qFrom: { x: this._lastApplyQx, y: this._lastApplyQy, z: this._lastApplyQz, w: this._lastApplyQw },
            qTo: { x: q.x, y: q.y, z: q.z, w: q.w },
            pFrom: { x: this._lastApplyPx, y: this._lastApplyPy, z: this._lastApplyPz },
            pTo: { x: p.x, y: p.y, z: p.z },
            dragging: this.dragging,
          });
        }
      }
    }
    this.applyPose();
  }

  private _haveLastApply = false;
  private _lastApplyQx = 0;
  private _lastApplyQy = 0;
  private _lastApplyQz = 0;
  private _lastApplyQw = 0;
  private _lastApplyPx = 0;
  private _lastApplyPy = 0;
  private _lastApplyPz = 0;

  getLookTarget(distance: number): THREE.Vector3 {
    _dir.copy(_FWD).applyQuaternion(this.orientation);
    return this.lockedPosition.clone().addScaledVector(_dir, distance);
  }

  dispose(): void {
    this.domElement.removeEventListener("pointerdown", this.onPointerDown, true);
    this.domElement.removeEventListener("pointermove", this.onPointerMove, true);
    this.domElement.removeEventListener("pointerup", this.onPointerUp, true);
    this.domElement.removeEventListener("pointercancel", this.onPointerUp, true);
  }

  private applyPose(): void {
    this.camera.position.set(this._lockX, this._lockY, this._lockZ);
    this.camera.quaternion.copy(this.orientation);
    /**
     * Three.js's quaternion->Euler sync (Object3D listener) can perturb
     * camera.quaternion by ~1 ulp on copy, and any consumer that reads the
     * matrix between this call and renderer.render (annotation overlay
     * projects with `matrixWorldInverse`, for example) would otherwise see a
     * stale-but-different transform vs. the rendered frame — the visible
     * symptom was a high-frequency wobble at certain interior angles. Force
     * the matrices to be up-to-date now so every reader within the frame
     * sees the same fixed pose.
     */
    this.camera.updateMatrix();
    this.camera.updateMatrixWorld(true);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    if (isFreelookDebug()) {
      const q = this.camera.quaternion;
      const p = this.camera.position;
      this._haveLastApply = true;
      this._lastApplyQx = q.x;
      this._lastApplyQy = q.y;
      this._lastApplyQz = q.z;
      this._lastApplyQw = q.w;
      this._lastApplyPx = p.x;
      this._lastApplyPy = p.y;
      this._lastApplyPz = p.z;
    }
  }

  /** orientation = R_y(yaw) * R_x(pitch). Both axes in world frame ⇒ no roll component. */
  private recomputeOrientation(): void {
    _qYaw.setFromAxisAngle(_worldUp, this.yaw);
    _qPitch.setFromAxisAngle(_worldX, this.pitch);
    this.orientation.copy(_qYaw).multiply(_qPitch);
  }

  private clampAngles(): void {
    this.pitch = THREE.MathUtils.clamp(this.pitch, this.pitchMin, this.pitchMax);
    if (this.constrainAngles) {
      this.yaw = THREE.MathUtils.clamp(this.yaw, this.yawMin, this.yawMax);
    } else {
      /**
       * Wrap yaw to (−π, π]. After many rotations setFromAxisAngle's
       * sin/cos lose precision and the recomputed orientation drifts at
       * ~1 ulp/frame — visible as a sub-pixel wobble after a long drag.
       */
      const TWO_PI = Math.PI * 2;
      this.yaw = ((this.yaw + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.button !== 0) return;
    if (this.dragging) return;
    this.dragging = true;
    this.activePointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.dragAxis = null;
    this.accumDx = 0;
    this.accumDy = 0;
    try {
      this.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.onDragStart?.();
    e.preventDefault();
    e.stopPropagation();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (!this.dragging) return;
    if (e.pointerId !== this.activePointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.dragAxis === null) {
      this.accumDx += dx;
      this.accumDy += dy;
      const ax = Math.abs(this.accumDx);
      const ay = Math.abs(this.accumDy);
      if (Math.max(ax, ay) < AXIS_LOCK_THRESHOLD_PX) return;
      this.dragAxis = ax >= ay ? "yaw" : "pitch";
    }

    if (this.dragAxis === "yaw") {
      this.yaw -= dx * this.rotateSpeed;
    } else {
      this.pitch -= dy * this.rotateSpeed;
    }
    this.clampAngles();
    this.recomputeOrientation();
    this.applyPose();

    e.preventDefault();
    e.stopPropagation();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    if (e.pointerId !== this.activePointerId) return;
    this.dragging = false;
    this.activePointerId = null;
    this.dragAxis = null;
    this.onDragEnd?.();
    try {
      this.domElement.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
    e.stopPropagation();
    this.onAfterLookChange?.();
  };
}
