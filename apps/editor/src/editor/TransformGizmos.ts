import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { TransformDef } from "@changan/shared";
import type { PerspectiveCamera } from "three";

export type GizmoMode = "translate" | "rotate" | "scale" | "pivotTranslate" | "pivotRotate";

export interface TransformGizmosOptions {
  camera: PerspectiveCamera;
  domElement: HTMLElement;
  orbitControls?: OrbitControls;
}

export class TransformGizmosController {
  private controls: TransformControls;
  private camera: PerspectiveCamera;
  private orbitControls?: OrbitControls;
  private onChange?: (transform: TransformDef) => void;

  constructor({ camera, domElement, orbitControls }: TransformGizmosOptions) {
    this.camera = camera;
    this.orbitControls = orbitControls;
    this.controls = new TransformControls(camera, domElement);
    this.controls.setMode("translate");

    this.controls.addEventListener("dragging-changed", (e) => {
      if (this.orbitControls) this.orbitControls.enabled = !e.value;
    });

    this.controls.addEventListener("objectChange", () => {
      const obj = this.controls.object;
      if (obj && this.onChange) {
        const pos = obj.position;
        const quat = obj.quaternion;
        const scale = obj.scale;
        const sx = typeof scale.x === "number" ? scale.x : 1;
        const sy = typeof scale.y === "number" ? scale.y : 1;
        const sz = typeof scale.z === "number" ? scale.z : 1;
        this.onChange({
          pos: [pos.x, pos.y, pos.z],
          rot: [quat.x, quat.y, quat.z, quat.w],
          scale: [sx, sy, sz],
        });
      }
    });
  }

  attachToScene(scene: THREE.Scene): void {
    scene.add(this.controls.getHelper());
  }

  setTarget(obj: THREE.Object3D | null): void {
    this.controls.detach();
    if (obj) {
      this.controls.attach(obj);
    }
  }

  setMode(mode: GizmoMode): void {
    const map: Record<GizmoMode, "translate" | "rotate" | "scale"> = {
      translate: "translate",
      rotate: "rotate",
      scale: "scale",
      pivotTranslate: "translate",
      pivotRotate: "rotate",
    };
    this.controls.setMode(map[mode] ?? "translate");
  }

  setTransform(transform: TransformDef): void {
    const obj = this.controls.object;
    if (!obj) return;
    obj.position.set(transform.pos[0], transform.pos[1], transform.pos[2]);
    obj.quaternion.set(
      transform.rot[0],
      transform.rot[1],
      transform.rot[2],
      transform.rot[3]
    );
    const s = transform.scale;
    if (typeof s === "number") {
      obj.scale.setScalar(s);
    } else {
      obj.scale.set(s[0], s[1], s[2]);
    }
  }

  /**
   * Update the pivot mesh's local offset. Must always pass the SplatMesh (child),
   * NOT the transform group — this must NOT go through this.controls.object.
   */
  applyPivotToMesh(
    mesh: THREE.Object3D,
    pivot: [number, number, number],
    pivotRot: [number, number, number, number]
  ): void {
    mesh.position.set(-pivot[0], -pivot[1], -pivot[2]);
    mesh.quaternion.set(pivotRot[0], pivotRot[1], pivotRot[2], pivotRot[3]);
  }

  setVisible(visible: boolean): void {
    this.controls.getHelper().visible = visible;
    this.controls.enabled = visible;
  }

  getVisible(): boolean {
    return this.controls.getHelper().visible;
  }

  /**
   * Disable gizmo pointer handling (e.g. interior free-look on the same canvas).
   * When `false`, restores enabled to match helper visibility (same as setVisible).
   */
  setPickingSuppressed(suppress: boolean): void {
    if (suppress) {
      this.controls.enabled = false;
    } else {
      this.controls.enabled = this.controls.getHelper().visible;
    }
  }

  onTransformChange(cb: (transform: TransformDef) => void): void {
    this.onChange = cb;
  }
}
