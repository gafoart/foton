import type {
  NamedCameraBookmark,
  ModelDef,
  SceneManifest,
  ViewMode,
} from "@changan/shared";
import { prefersLightweightScene } from "../scene/LODSelector.js";

export type LoadScope = "all" | "single";

export type UrlViewParam = "ext" | "motor" | "trunk" | "int";
const ALLOWED_URL_VIEWS: readonly UrlViewParam[] = ["ext", "motor", "trunk", "int"];

export interface ResolvedShowroomUrlParams {
  /**
   * Dealership splat + floor/ceiling GLBs.
   * Default on desktop when `dealer` / `backdrop` are omitted from the URL; or when `dealer=1`.
   */
  showDealership: boolean;
  /**
   * `blackdrop.glb` (+ Changan 3D).
   * Default on mobile when `dealer` / `backdrop` are omitted; or when `backdrop=1`.
   */
  showBackdrop: boolean;
  loadScope: LoadScope;
  /** Boot model id (manifest casing) */
  modelId: string;
  /** Boot accessory id (manifest casing) or null for base-only. */
  accessoryId: string | null;
  /** Initial scene viewMode (drives default asset/layer selection). */
  viewMode: ViewMode;
  /** Index into the chosen model's `cameraBookmarks` array. 0 if unresolved. */
  initialBookmarkIndex: number;
  /**
   * True iff `?view=` was supplied and successfully mapped to a bookmark.
   * Consumed by `main.ts` so URL view always wins over the saved last view.
   */
  urlViewExplicit: boolean;
}

function findModelIdCaseInsensitive(
  manifest: SceneManifest,
  raw: string
): string | undefined {
  const lower = raw.toLowerCase();
  return manifest.models.find((m) => m.id.toLowerCase() === lower)?.id;
}

function findAccessoryIdCaseInsensitive(
  model: ModelDef,
  raw: string
): string | undefined {
  const lower = raw.toLowerCase();
  return model.accessories.find((a) => a.id.toLowerCase() === lower)?.id;
}

/**
 * Map a `?view=` value to a bookmark index inside the model's
 * `cameraBookmarks` array, using the bookmark `visibility` flags:
 *   - `ext`   → first bookmark whose visibility.base is true and interior is not
 *   - `trunk` → first bookmark whose visibility.motor is true
 *   - `motor` → second bookmark whose visibility.motor is true (falls back to the first)
 *   - `int`   → first bookmark whose visibility.interior is true
 *
 * Returns `-1` when the requested slot does not exist on this model (caller
 * falls back to the default first programmed camera).
 */
function bookmarkIndexForUrlView(
  bookmarks: readonly NamedCameraBookmark[],
  view: UrlViewParam
): number {
  if (bookmarks.length === 0) return -1;
  let motorHits = 0;
  let firstMotorIdx = -1;
  for (let i = 0; i < bookmarks.length; i++) {
    const vis = bookmarks[i].visibility;
    if (view === "ext" && vis.base && !vis.interior) return i;
    if (view === "int" && vis.interior) return i;
    if ((view === "motor" || view === "trunk") && vis.motor) {
      motorHits++;
      if (firstMotorIdx === -1) firstMotorIdx = i;
      if (view === "trunk" && motorHits === 1) return i;
      if (view === "motor" && motorHits === 2) return i;
    }
  }
  /** `motor` with only one motor bookmark → use that one. */
  if (view === "motor") return firstMotorIdx;
  return -1;
}

function viewModeFromBookmark(bm: NamedCameraBookmark): ViewMode {
  if (bm.visibility.interior) return "interior";
  if (bm.visibility.motor) return "motor";
  return "exterior";
}

/**
 * Parse URL search params and resolve initial showroom state against the manifest.
 *
 * **Dealership vs backdrop**
 * - If both `dealer` and `backdrop` are absent from the query string: desktop loads the dealership
 *   (splats + floor/ceiling); mobile loads the backdrop (`blackdrop.glb`).
 * - If either key is present, only `=1` enables that mode (same as before); the other stays off unless also `=1`.
 *
 * **Model / accessory / view**
 * - `?model=<id>`  picks a specific model. Aliased to legacy `?load=<id>`; `?load=all` keeps its
 *   special meaning (preload every car). When `model` is missing, the resolver falls back to the
 *   `fallback.modelId` (saved last view) and then to `manifest.defaults.modelId`.
 * - `?acc=<accessoryId>` — validated (case-insensitive) against the chosen model's accessories.
 *   Unknown values fall back to base-only. When omitted, the saved last view's accessory (if it
 *   still exists on the model) and then `manifest.defaults.accessoryId` apply.
 * - `?view=<ext|motor|trunk|int>` — picks a programmed camera by layer ordering (see
 *   {@link bookmarkIndexForUrlView}). When set successfully, this overrides any saved bookmark
 *   index from `fallback`; when missing/invalid, the resolver returns `initialBookmarkIndex: 0`
 *   and consumers can decide whether to honour the saved index.
 *
 * **Fallback (restored from last session)**
 * - URL params always win over `fallback`. When `model` or `acc` is omitted from the URL, the
 *   resolver uses the fallback if it validates against the manifest. This lets a tab reload
 *   restore the last-viewed model + accessory while keeping shared links deterministic.
 */
export interface ShowroomUrlFallback {
  modelId?: string;
  accessoryId?: string | null;
}

export function resolveShowroomUrlParams(
  manifest: SceneManifest,
  fallback?: ShowroomUrlFallback
): ResolvedShowroomUrlParams {
  const params = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : ""
  );

  const hasDealerParam = params.has("dealer");
  const hasBackdropParam = params.has("backdrop");

  let showDealership: boolean;
  let showBackdrop: boolean;
  if (!hasDealerParam && !hasBackdropParam) {
    /**
     * FOTON default composition: the blackdrop (+ brand 3D, fog) ALWAYS loads —
     * it's the scene the editor authors. Desktop additionally loads the
     * dealership environment layers (floor/ceiling/pano; the legacy dealership
     * splat 404s harmlessly if absent). Lightweight devices skip those extras.
     */
    const lightweight = prefersLightweightScene();
    showDealership = !lightweight;
    showBackdrop = true;
  } else {
    showDealership = hasDealerParam && params.get("dealer") === "1";
    showBackdrop = hasBackdropParam && params.get("backdrop") === "1";
  }

  const fallbackModelId = (): string =>
    manifest.defaults.modelId || manifest.models[0]?.id || "";

  /**
   * `model` is the new explicit alias; `load` keeps the old "all" semantics
   * and also accepts a model id for backward compat with shared links. The
   * explicit `model` wins when both are present.
   */
  const modelRaw = params.get("model");
  const loadRaw = params.get("load");

  let loadScope: LoadScope = "single";
  let modelId = fallbackModelId();

  const applyFallbackOrDefault = (): void => {
    const saved = fallback?.modelId
      ? findModelIdCaseInsensitive(manifest, fallback.modelId)
      : undefined;
    modelId = saved ?? fallbackModelId();
  };

  if (modelRaw && modelRaw.length > 0) {
    const found = findModelIdCaseInsensitive(manifest, modelRaw);
    if (found) {
      modelId = found;
    } else {
      console.warn(
        `[viewer] Unknown model "${modelRaw}", falling back to defaults`
      );
      applyFallbackOrDefault();
    }
    if (loadRaw && loadRaw.toLowerCase() === "all") loadScope = "all";
  } else if (loadRaw === null || loadRaw === "") {
    applyFallbackOrDefault();
  } else if (loadRaw.toLowerCase() === "all") {
    loadScope = "all";
    modelId = fallbackModelId();
  } else {
    const found = findModelIdCaseInsensitive(manifest, loadRaw);
    if (found) {
      modelId = found;
    } else {
      console.warn(
        `[viewer] Unknown load model "${loadRaw}", falling back to defaults`
      );
      modelId = fallbackModelId();
    }
  }

  const model = manifest.models.find((m) => m.id === modelId);

  /**
   * Accessory resolution. `?acc=` wins; the value must exist on the chosen
   * model or we fall back to base-only. Without a URL param, the saved last
   * view's accessory (validated) applies, then the manifest default
   * (`defaults.accessoryId`, also validated), then base-only (null).
   */
  let accessoryId: string | null = null;
  const accRaw = params.get("acc");
  if (accRaw && accRaw.length > 0) {
    const matched = model
      ? findAccessoryIdCaseInsensitive(model, accRaw)
      : undefined;
    if (matched) {
      accessoryId = matched;
    } else {
      console.warn(
        `[viewer] Unknown accessory "${accRaw}" for model "${modelId}", showing base only`
      );
    }
  } else if (fallback?.accessoryId && model) {
    accessoryId =
      findAccessoryIdCaseInsensitive(model, fallback.accessoryId) ?? null;
  } else if (manifest.defaults.accessoryId && model) {
    accessoryId =
      findAccessoryIdCaseInsensitive(model, manifest.defaults.accessoryId) ??
      null;
  }

  /**
   * View resolution. When the URL view is valid AND the model exposes the
   * requested camera slot, we set `urlViewExplicit` so `main.ts` ignores any
   * saved bookmark from localStorage. Otherwise consumers fall back to their
   * existing behaviour (saved index, then bookmark 0).
   */
  let viewMode: ViewMode = manifest.defaults.view;
  let initialBookmarkIndex = 0;
  let urlViewExplicit = false;
  const viewRaw = params.get("view");
  if (viewRaw && viewRaw.length > 0) {
    const lowered = viewRaw.toLowerCase() as UrlViewParam;
    if ((ALLOWED_URL_VIEWS as readonly string[]).includes(lowered)) {
      const bookmarks = model?.cameraBookmarks ?? [];
      const idx = bookmarkIndexForUrlView(bookmarks, lowered);
      if (idx >= 0) {
        initialBookmarkIndex = idx;
        viewMode = viewModeFromBookmark(bookmarks[idx]);
        urlViewExplicit = true;
      } else {
        console.warn(
          `[viewer] No "${lowered}" bookmark on model "${modelId}", using default view`
        );
      }
    } else {
      console.warn(
        `[viewer] Unsupported view "${viewRaw}" — only ${ALLOWED_URL_VIEWS.join(", ")} are accepted; using default view`
      );
    }
  }

  return {
    showDealership,
    showBackdrop,
    loadScope,
    modelId,
    accessoryId,
    viewMode,
    initialBookmarkIndex,
    urlViewExplicit,
  };
}
