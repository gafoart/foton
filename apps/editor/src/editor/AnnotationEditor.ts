import * as THREE from "three";
import type { Raycaster, Vector3 } from "three";
import type { AnnotationDef, ViewMode } from "@changan/shared";
import type { PerspectiveCamera } from "three";

export interface AnnotationEditorOptions {
  camera: PerspectiveCamera;
  domElement: HTMLElement;
}

export class AnnotationEditorController {
  private camera: PerspectiveCamera;
  private domElement: HTMLElement;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private onPlace?: (pos: [number, number, number]) => void;
  private onSelect?: (annotation: AnnotationDef) => void;

  constructor({ camera, domElement }: AnnotationEditorOptions) {
    this.camera = camera;
    this.domElement = domElement;

    domElement.addEventListener("click", (e) => this.onClick(e));
  }

  setPlaceCallback(cb: (pos: [number, number, number]) => void): void {
    this.onPlace = cb;
  }

  setSelectCallback(cb: (annotation: AnnotationDef) => void): void {
    this.onSelect = cb;
  }

  getIntersection(
    sceneObjects: THREE.Object3D[],
    point: { x: number; y: number }
  ): Vector3 | null {
    this.mouse.x = (point.x / this.domElement.clientWidth) * 2 - 1;
    this.mouse.y = -(point.y / this.domElement.clientHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(sceneObjects, true);
    return intersects.length > 0 ? intersects[0].point : null;
  }

  private onClick(e: MouseEvent): void {
    const rect = this.domElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const sceneObjects = this.getSceneObjects();
    const point = this.getIntersection(sceneObjects, { x, y });
    if (point && this.onPlace) {
      this.onPlace([point.x, point.y, point.z]);
    }
  }

  private getSceneObjects(): THREE.Object3D[] {
    const container = this.domElement.querySelector("canvas")?.parentElement;
    if (!container) return [];
    return [];
  }

  selectAnnotation(annotation: AnnotationDef): void {
    this.onSelect?.(annotation);
  }
}
