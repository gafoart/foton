import * as THREE from "three";
import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import type { AssetDef, SplatFileType as ManifestFileType, TransformDef } from "@changan/shared";
import {
  LRUCache,
  getPivot,
  getPivotRot,
  getScale,
  resolveSplatAssetUrl,
} from "@changan/shared";
import type { SceneRuntime } from "@changan/scene-runtime";
import type { QualityProfile } from "./LODSelector.js";

class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.permits = maxConcurrent;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.permits--;
        resolve();
      });
    });
  }

  release(): void {
    this.permits++;
    const next = this.waiting.shift();
    if (next) next();
  }
}

function getExtension(url: string): string {
  return url.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase() ?? "";
}

function toSparkFileType(t: ManifestFileType): SplatFileType | undefined {
  const map: Record<ManifestFileType, SplatFileType> = {
    ply: SplatFileType.PLY,
    spz: SplatFileType.SPZ,
    splat: SplatFileType.SPLAT,
    ksplat: SplatFileType.KSPLAT,
    sogs: SplatFileType.PCSOGS,
    zip: SplatFileType.PCSOGSZIP,
  };
  return map[t];
}

function inferFileTypeFromUrl(url: string): SplatFileType | undefined {
  const ext = getExtension(url);
  const map: Record<string, SplatFileType> = {
    sog: SplatFileType.PCSOGSZIP,
    sag: SplatFileType.PCSOGSZIP,
    ozg: SplatFileType.PCSOGSZIP,
    zip: SplatFileType.PCSOGSZIP,
    sogs: SplatFileType.PCSOGS,
    ply: SplatFileType.PLY,
    spz: SplatFileType.SPZ,
    splat: SplatFileType.SPLAT,
    ksplat: SplatFileType.KSPLAT,
    ksg: SplatFileType.KSPLAT,
  };
  return map[ext];
}

/**
 * Returns true for formats that MUST be loaded via URL (not fileBytes).
 * .sogs (PCSOGS) is a JSON that references chunk files via relative URLs —
 * Spark needs to fetch those chunks itself, so we cannot pass raw bytes.
 */
function requiresUrlLoading(assetDef: AssetDef): boolean {
  if (assetDef.fileType === "sogs") return true;
  return getExtension(assetDef.url) === "sogs";
}

function modelIdFromAssetKey(key: string): string {
  const i = key.indexOf(":");
  return i === -1 ? key : key.slice(0, i);
}

/** Download progress 0..1 within [dlStart, dlEnd]; then caller bumps to 1 after init. */
export async function fetchArrayBufferWithProgress(
  url: string,
  signal: AbortSignal | undefined,
  onDownloadProgress: ((fraction: number) => void) | undefined,
  dlStart: number,
  dlEnd: number
): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${url}`);
  const totalHeader = res.headers.get("content-length");
  const total = totalHeader ? parseInt(totalHeader, 10) : NaN;
  if (!res.body || !Number.isFinite(total) || total <= 0) {
    const buf = await res.arrayBuffer();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    onDownloadProgress?.(dlEnd);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      const f = received / total;
      onDownloadProgress?.(dlStart + f * (dlEnd - dlStart));
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  onDownloadProgress?.(dlEnd);
  return out.buffer;
}

function sparkProgressToUnit(
  onProgress: ((t: number) => void) | undefined,
  rangeStart: number,
  rangeEnd: number
): ((event: ProgressEvent) => void) | undefined {
  if (!onProgress) return undefined;
  return (event: ProgressEvent) => {
    if (event.lengthComputable && event.total > 0) {
      const u = event.loaded / event.total;
      onProgress(rangeStart + u * (rangeEnd - rangeStart));
    }
  };
}

function applyTransform(
  mesh: SplatMesh,
  transform: TransformDef,
  assetKey: string
): THREE.Group {
  const pivot = getPivot(transform);
  const pivotRot = getPivotRot(transform);

  const group = new THREE.Group();
  group.userData.assetKey = assetKey;
  group.userData.modelId = modelIdFromAssetKey(assetKey);
  group.position.set(transform.pos[0], transform.pos[1], transform.pos[2]);
  group.quaternion.set(
    transform.rot[0],
    transform.rot[1],
    transform.rot[2],
    transform.rot[3]
  );
  const [sx, sy, sz] = getScale(transform);
  group.scale.set(sx, sy, sz);

  mesh.position.set(-pivot[0], -pivot[1], -pivot[2]);
  mesh.quaternion.set(pivotRot[0], pivotRot[1], pivotRot[2], pivotRot[3]);
  mesh.scale.setScalar(1);
  group.add(mesh);

  // Caller / bookmark visibility sets this; avoids a one-frame flash when parallel loads finish out of order.
  group.visible = false;

  return group;
}

export interface AssetManagerOptions {
  runtime: SceneRuntime;
  maxConcurrent?: number;
  maxCacheSize?: number;
  isMobile?: boolean;
  qualityProfile?: QualityProfile;
  /**
   * Fired once per fresh load (not on cache hits) after the group is in the
   * scene. Use to attach per-load shader modifiers etc.
   */
  onAssetLoaded?: (key: string, group: THREE.Group) => void;
}

export interface LoadAssetOptions {
  signal?: AbortSignal;
  /** Overall load progress for this asset, 0..1 (download + decode). */
  onProgress?: (unit: number) => void;
}

export class AssetManager {
  private runtime: SceneRuntime;
  private semaphore: Semaphore;
  private cache: LRUCache<string, THREE.Group>;
  private prefetchQueue: Array<{ key: string; assetDef: AssetDef }> = [];
  private prefetchScheduled = false;
  /** Never LRU-evict these keys (showroom active vehicle exterior/detail/interior). */
  private protectedPresentationKeys = new Set<string>();
  private onAssetLoaded?: (key: string, group: THREE.Group) => void;
  private qualityProfile?: QualityProfile;

  constructor({
    runtime,
    maxConcurrent = 4,
    /** Enough for several models × (exterior + detail + interior) before LRU evicts active layers. */
    maxCacheSize = 48,
    isMobile = false,
    qualityProfile,
    onAssetLoaded,
  }: AssetManagerOptions) {
    this.runtime = runtime;
    this.qualityProfile = qualityProfile;
    this.onAssetLoaded = onAssetLoaded;
    const concurrent = isMobile ? 2 : maxConcurrent;
    /**
     * Mobile cache is bounded by iOS Safari's roughly 250 MB tab-kill
     * threshold. With splats averaging 5-15 MB raw + GPU residency, 10
     * entries (~100-150 MB) leaves headroom for Three.js, Spark's WASM
     * heap, and the rest of the page.
     */
    const cacheSize = isMobile ? 10 : maxCacheSize;
    this.semaphore = new Semaphore(concurrent);
    this.cache = new LRUCache<string, THREE.Group>({
      maxSize: cacheSize,
      canEvictKey: (k) => !this.protectedPresentationKeys.has(k),
      onEvict: (_evictKey, group) => {
        const mesh = group.children[0];
        if (mesh && "dispose" in mesh && typeof (mesh as SplatMesh).dispose === "function") {
          (mesh as SplatMesh).dispose();
        }
        runtime.getSplatContainer().remove(group);
      },
    });
  }

  /** Pin keys so background lazy loads cannot evict the active presentation car's layers. */
  setProtectedPresentationKeys(keys: readonly string[]): void {
    this.protectedPresentationKeys = new Set(keys);
  }

  /**
   * Drop every cached asset that is not currently protected. Used when the
   * tab is backgrounded — iOS Safari often reaps idle tabs that hold a lot of
   * GPU memory, so trimming on `visibilitychange` keeps the active session
   * alive when the user returns. Returns the number of entries freed.
   */
  trimToProtected(): number {
    let evicted = 0;
    for (const key of [...this.cache.keys()]) {
      if (!this.protectedPresentationKeys.has(key)) {
        if (this.cache.delete(key)) evicted++;
      }
    }
    this.prefetchQueue = [];
    return evicted;
  }

  /**
   * Load asset by key. Routes to URL-based loading for .sogs files (which
   * need to fetch relative chunk files), and to fetch→bytes for everything
   * else (enables AbortController cancellation).
   */
  async loadAsset(
    key: string,
    assetDef: AssetDef,
    options?: LoadAssetOptions
  ): Promise<THREE.Group> {
    const signal = options?.signal;
    const onProgress = options?.onProgress;

    const cached = this.cache.get(key);
    if (cached) {
      if (!cached.parent) {
        this.runtime.getSplatContainer().add(cached);
      }
      onProgress?.(1);
      return cached;
    }

    await this.semaphore.acquire();
    try {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const url = resolveSplatAssetUrl(assetDef.url);
      let sparkFileType = assetDef.fileType
        ? toSparkFileType(assetDef.fileType)
        : undefined;
      if (!sparkFileType) sparkFileType = inferFileTypeFromUrl(assetDef.url);
      if (!sparkFileType && /\.(sog|sag|ozg|zip)$/i.test(assetDef.url.split("?")[0])) {
        sparkFileType = SplatFileType.PCSOGSZIP;
      }

      let mesh: SplatMesh;

      if (requiresUrlLoading(assetDef)) {
        const sparkCb = sparkProgressToUnit(onProgress, 0, 0.92);
        mesh = await this.runtime.loadSplat(url, sparkFileType, sparkCb, this.qualityProfile?.maxSplats);
        if (signal?.aborted) {
          this.runtime.removeSplat(mesh);
          throw new DOMException("Aborted", "AbortError");
        }
        onProgress?.(1);
      } else {
        const bytes = await fetchArrayBufferWithProgress(
          url,
          signal,
          onProgress,
          0,
          0.88
        );
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const array = new Uint8Array(bytes);
        const splatMesh = new SplatMesh({
          fileBytes: array,
          fileType: sparkFileType,
          ...(this.qualityProfile?.maxSplats !== undefined
            ? { maxSplats: this.qualityProfile.maxSplats }
            : {}),
          ...(onProgress
            ? { onProgress: sparkProgressToUnit(onProgress, 0.88, 0.98) }
            : {}),
        } as Record<string, unknown>);
        await splatMesh.initialized;
        if (signal?.aborted) {
          splatMesh.dispose();
          throw new DOMException("Aborted", "AbortError");
        }
        onProgress?.(1);
        mesh = splatMesh;
      }

      if (this.qualityProfile) {
        mesh.maxSh = this.qualityProfile.maxSh;
        mesh.updateGenerator();
      }

      const container = this.runtime.getSplatContainer();
      if (requiresUrlLoading(assetDef)) {
        container.remove(mesh);
      }
      const group = applyTransform(mesh, assetDef.transform, key);
      container.add(group);
      this.cache.set(key, group);
      this.onAssetLoaded?.(key, group);
      return group;
    } finally {
      this.semaphore.release();
    }
  }

  unloadAsset(key: string): boolean {
    return this.cache.delete(key);
  }

  getCached(key: string): THREE.Group | undefined {
    return this.cache.get(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Low-priority prefetch. Uses requestIdleCallback when available.
   */
  prefetch(items: Array<{ key: string; assetDef: AssetDef }>): void {
    for (const item of items) {
      if (this.cache.has(item.key)) continue;
      this.prefetchQueue.push(item);
    }
    this.schedulePrefetch();
  }

  private schedulePrefetch(): void {
    if (this.prefetchScheduled || this.prefetchQueue.length === 0) return;
    this.prefetchScheduled = true;

    const runNext = () => {
      const item = this.prefetchQueue.shift();
      this.prefetchScheduled = false;
      if (!item) return;

      const run = () => this.prefetchOne(item);
      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(run, { timeout: 2000 });
      } else {
        setTimeout(run, 100);
      }
    };

    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(runNext, { timeout: 100 });
    } else {
      setTimeout(runNext, 100);
    }
  }

  private async prefetchOne(item: {
    key: string;
    assetDef: AssetDef;
  }): Promise<void> {
    try {
      await this.semaphore.acquire();
      const url = resolveSplatAssetUrl(item.assetDef.url);
      const sparkFileType = item.assetDef.fileType
        ? toSparkFileType(item.assetDef.fileType)
        : undefined;

      let mesh: SplatMesh;

      if (requiresUrlLoading(item.assetDef)) {
        mesh = await this.runtime.loadSplat(url, sparkFileType, undefined, this.qualityProfile?.maxSplats);
        this.runtime.getSplatContainer().remove(mesh);
      } else {
        const res = await fetch(url);
        if (!res.ok) return;
        const bytes = await res.arrayBuffer();
        mesh = new SplatMesh({
          fileBytes: new Uint8Array(bytes),
          fileType: sparkFileType,
          ...(this.qualityProfile?.maxSplats !== undefined
            ? { maxSplats: this.qualityProfile.maxSplats }
            : {}),
        } as Record<string, unknown>);
        await mesh.initialized;
      }

      if (this.qualityProfile) {
        mesh.maxSh = this.qualityProfile.maxSh;
        mesh.updateGenerator();
      }

      const group = applyTransform(mesh, item.assetDef.transform, item.key);
      this.cache.set(item.key, group);
      const container = this.runtime.getSplatContainer();
      if (!group.parent) {
        container.add(group);
      }
      this.onAssetLoaded?.(item.key, group);
    } catch {
      // Ignore prefetch errors
    } finally {
      this.semaphore.release();
      if (this.prefetchQueue.length > 0) {
        this.prefetchScheduled = true;
        this.schedulePrefetch();
      }
    }
  }
}
