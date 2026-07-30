import * as THREE from "three";
import type {
  AnnotationDef,
  ViewMode,
  CameraBookmark,
} from "@changan/shared";
import type { PerspectiveCamera } from "three";

export interface AnnotationSystemOptions {
  camera: PerspectiveCamera;
  container: HTMLElement;
}

export class AnnotationSystem {
  private camera: PerspectiveCamera;
  private container: HTMLElement;
  private annotations: AnnotationDef[] = [];
  private viewMode: ViewMode = "exterior";
  /** When set (presentation mode), filter annotations by these visible views instead of viewMode. */
  private visibleViews: Record<ViewMode, boolean> | null = null;
  private bookmarks: Partial<Record<ViewMode, CameraBookmark>> | null = null;
  private pinsContainer: HTMLElement | null = null;
  private rafId: number | null = null;
  private onFocusBookmark?: (bookmark: CameraBookmark) => void;

  constructor({ camera, container }: AnnotationSystemOptions) {
    this.camera = camera;
    this.container = container;
  }

  setAnnotations(annotations: AnnotationDef[]): void {
    this.annotations = annotations;
  }

  setViewMode(viewMode: ViewMode): void {
    this.viewMode = viewMode;
  }

  /** Presentation mode: show annotations for views where visibility is true. */
  setVisibleViews(visibility: Record<ViewMode, boolean> | null): void {
    this.visibleViews = visibility;
  }

  setBookmarks(
    bookmarks: Partial<Record<ViewMode, CameraBookmark>> | null
  ): void {
    this.bookmarks = bookmarks;
  }

  onBookmarkFocus(cb: (bookmark: CameraBookmark) => void): void {
    this.onFocusBookmark = cb;
  }

  update(): void {
    if (!this.pinsContainer) {
      this.pinsContainer = document.createElement("div");
      this.pinsContainer.className = "annotations-overlay";
      this.container.appendChild(this.pinsContainer);
    }

    const visible = this.annotations.filter((a) =>
      this.visibleViews ? this.visibleViews[a.view] : a.view === this.viewMode
    );
    const vector = new THREE.Vector3();

    while (this.pinsContainer.children.length < visible.length) {
      const pin = document.createElement("div");
      pin.className = "annotation-pin";
      const text = document.createElement("span");
      text.className = "annotation-text";
      pin.appendChild(text);
      pin.addEventListener("click", () => this.onPinClick(pin));
      this.pinsContainer.appendChild(pin);
    }

    while (this.pinsContainer.children.length > visible.length) {
      this.pinsContainer.removeChild(this.pinsContainer.lastChild!);
    }

    for (let i = 0; i < visible.length; i++) {
      const ann = visible[i];
      const pin = this.pinsContainer.children[i] as HTMLElement;
      const textEl = pin.querySelector(".annotation-text") as HTMLElement;

      vector.set(ann.pos[0], ann.pos[1], ann.pos[2]);
      vector.project(this.camera);

      const x = (vector.x * 0.5 + 0.5) * this.container.clientWidth;
      const y = (-vector.y * 0.5 + 0.5) * this.container.clientHeight;

      const inFront = vector.z >= -1 && vector.z <= 1;

      pin.dataset.annotationId = ann.id;
      pin.dataset.bookmarkId = ann.bookmarkId ?? "";
      pin.style.display = inFront ? "flex" : "none";
      pin.style.left = `${x}px`;
      pin.style.top = `${y}px`;
      pin.style.transform = "translate(-50%, -50%)";
      textEl.textContent = ann.text;
    }
  }

  startUpdateLoop(): void {
    const tick = () => {
      this.update();
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  stopUpdateLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private onPinClick(pin: HTMLElement): void {
    const bookmarkId = pin.dataset.bookmarkId;
    if (!bookmarkId || !this.bookmarks || !this.onFocusBookmark) return;
    const view = bookmarkId as ViewMode;
    const bm = this.bookmarks[view];
    if (bm) {
      this.onFocusBookmark(bm);
    }
  }
}
