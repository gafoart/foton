import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SplatMesh, SparkRenderer, SplatFileType } from "@sparkjsdev/spark";

export interface SceneRuntimeOptions {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  /** Called each frame before controls update. Use for custom camera logic (e.g. WASD movement). */
  onTick?: () => void;
  /**
   * Called after OrbitControls.update(). Use to re-apply camera state that orbit would overwrite
   * (e.g. interior free-look while controls.enabled is false).
   */
  onAfterControlsUpdate?: () => void;
  /**
   * When true, OrbitControls.update is skipped for this frame. Use during free-look so damping
   * and lookAt(target) do not fight a fixed eye + euler look (avoids jitter).
   */
  shouldSkipControlsUpdate?: () => boolean;
  /**
   * Returns true when the runtime can SKIP `renderer.render()` for this frame.
   * Use to freeze the canvas while nothing is animating — Spark re-sorts splats
   * on every render, and at certain camera angles the sort flips between
   * near-tied splats every frame, producing a visible per-frame shimmer on the
   * model. Skipping render leaves the previous frame's pixels on screen.
   * The runtime auto-renders any frame where the camera moved since the last
   * render, so callers only need to gate on animation/input liveness.
   */
  canSkipRenderWhenIdle?: () => boolean;
}

export class SceneRuntime {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly spark: SparkRenderer;
  private splatContainer: THREE.Group;
  private animationId: number | null = null;
  private resizeObserver: ResizeObserver;
  private onTick?: () => void;
  private onAfterControlsUpdate?: () => void;
  private shouldSkipControlsUpdate?: () => boolean;
  private canSkipRenderWhenIdle?: () => boolean;
  private forceRenderFrames = 3;
  private settleRenderTimeout: ReturnType<typeof setTimeout> | null = null;
  private settleRenderTimeout2: ReturnType<typeof setTimeout> | null = null;
  private lastRenderedPx = NaN;
  private lastRenderedPy = NaN;
  private lastRenderedPz = NaN;
  private lastRenderedQx = NaN;
  private lastRenderedQy = NaN;
  private lastRenderedQz = NaN;
  private lastRenderedQw = NaN;

  constructor({
    canvas,
    container,
    onTick,
    onAfterControlsUpdate,
    shouldSkipControlsUpdate,
    canSkipRenderWhenIdle,
  }: SceneRuntimeOptions) {
    // Use window dimensions as fallback in case container hasn't painted yet
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // Spark requirement for performance
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x0a0a0a, 1);

    this.scene = new THREE.Scene();
    const aspect = w / h;
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1000);
    this.camera.position.set(0, 1.5, 3);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.onTick = onTick;
    this.onAfterControlsUpdate = onAfterControlsUpdate;
    this.shouldSkipControlsUpdate = shouldSkipControlsUpdate;
    this.canSkipRenderWhenIdle = canSkipRenderWhenIdle;

    this.spark = new SparkRenderer({
      renderer: this.renderer,
    });
    this.camera.add(this.spark);
    this.scene.add(this.camera);

    this.splatContainer = new THREE.Group();
    this.scene.add(this.splatContainer);

    this.resizeObserver = new ResizeObserver(() => this.onResize(container));
    this.resizeObserver.observe(container);
  }

  private onResize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /**
   * Load a splat from URL (Spark fetches internally). Required for .sogs files.
   * Also used as a fallback for any format with an explicit fileType.
   */
  async loadSplat(
    url: string,
    fileType?: SplatFileType,
    onProgress?: (event: ProgressEvent) => void,
    maxSplats?: number
  ): Promise<SplatMesh> {
    // Spark runtime supports onProgress; typings may lag behind.
    const splatMesh = new SplatMesh({
      url,
      fileType,
      ...(maxSplats !== undefined ? { maxSplats } : {}),
      ...(onProgress ? { onProgress } : {}),
    } as Record<string, unknown>);
    await splatMesh.initialized;
    this.splatContainer.add(splatMesh);
    return splatMesh;
  }

  /**
   * Load a splat from raw bytes (enables AbortController for cancellation).
   */
  async loadSplatFromBytes(
    bytes: ArrayBuffer | Uint8Array,
    signal?: AbortSignal,
    fileType?: SplatFileType
  ): Promise<SplatMesh> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const array = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    const splatMesh = new SplatMesh({ fileBytes: array, fileType });
    await splatMesh.initialized;
    if (signal?.aborted) {
      splatMesh.dispose();
      throw new DOMException("Aborted", "AbortError");
    }
    this.splatContainer.add(splatMesh);
    return splatMesh;
  }

  /**
   * Remove a splat from the scene and dispose it.
   */
  removeSplat(splatMesh: SplatMesh): void {
    this.splatContainer.remove(splatMesh);
    splatMesh.dispose();
  }

  /**
   * Get the splat container group (for adding/removing meshes).
   */
  getSplatContainer(): THREE.Group {
    return this.splatContainer;
  }

  /**
   * Force the next few frames to render even if `canSkipRenderWhenIdle`
   * returns true (e.g., a splat just finished loading and changed the scene
   * but the camera didn't move). Cheap to over-call.
   */
  requestRender(frames: number = 3): void {
    if (frames > this.forceRenderFrames) this.forceRenderFrames = frames;
  }

  /**
   * Schedule render bursts after a delay so Spark's async splat sort has
   * time to finish and upload. Call after any instant camera jump or scene
   * change to avoid the "unsorted splats until user interacts" artifact.
   */
  scheduleSettleRenders(): void {
    setTimeout(() => this.requestRender(3), 400);
    setTimeout(() => this.requestRender(3), 900);
  }

  startRenderLoop(): void {
    const tick = () => {
      this.onTick?.();
      if (this.shouldSkipControlsUpdate?.() !== true) {
        this.controls.update();
      }
      this.onAfterControlsUpdate?.();

      const p = this.camera.position;
      const q = this.camera.quaternion;
      const cameraMoved =
        p.x !== this.lastRenderedPx ||
        p.y !== this.lastRenderedPy ||
        p.z !== this.lastRenderedPz ||
        q.x !== this.lastRenderedQx ||
        q.y !== this.lastRenderedQy ||
        q.z !== this.lastRenderedQz ||
        q.w !== this.lastRenderedQw;

      /**
       * Spark sorts splats on a worker, then uploads the result back; a sort
       * triggered by the most recent camera move can land 5–15 frames later.
       * Approach: render a small immediate window so animations are smooth,
       * then go idle. After a fixed settle delay, fire ONE more render —
       * by then the async sort has finished and uploaded, so that final
       * frame captures the settled splat ordering. This avoids the shimmer
       * that happens when we keep re-sorting every frame, and avoids the
       * "missing splats" symptom from freezing too early.
       */
      if (cameraMoved) {
        if (this.forceRenderFrames < 4) this.forceRenderFrames = 4;
        if (this.settleRenderTimeout !== null) {
          clearTimeout(this.settleRenderTimeout);
        }
        if (this.settleRenderTimeout2 !== null) {
          clearTimeout(this.settleRenderTimeout2);
        }
        this.settleRenderTimeout = setTimeout(() => {
          this.settleRenderTimeout = null;
          this.requestRender(3);
        }, 350);
        this.settleRenderTimeout2 = setTimeout(() => {
          this.settleRenderTimeout2 = null;
          this.requestRender(3);
        }, 800);
      }

      const idle =
        !cameraMoved &&
        this.forceRenderFrames <= 0 &&
        this.canSkipRenderWhenIdle?.() === true;

      if (!idle) {
        this.renderer.render(this.scene, this.camera);
        this.lastRenderedPx = p.x;
        this.lastRenderedPy = p.y;
        this.lastRenderedPz = p.z;
        this.lastRenderedQx = q.x;
        this.lastRenderedQy = q.y;
        this.lastRenderedQz = q.z;
        this.lastRenderedQw = q.w;
        if (this.forceRenderFrames > 0) this.forceRenderFrames -= 1;
      }
      this.animationId = requestAnimationFrame(tick);
    };
    tick();
  }

  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.resizeObserver.disconnect();
    this.controls.dispose();
    while (this.splatContainer.children.length > 0) {
      const child = this.splatContainer.children[0];
      if (child instanceof SplatMesh) {
        child.dispose();
      }
      this.splatContainer.remove(child);
    }
    this.renderer.dispose();
  }
}

export { FreeLookController } from "./FreeLookController.js";
export { clearOrbitControlsTransientState } from "./orbitControlsTransient.js";
export * from "./sceneAppearance.js";
