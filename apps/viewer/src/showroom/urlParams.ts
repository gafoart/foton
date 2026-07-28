import type {
  NamedCameraBookmark,
  ModelDef,
  SceneManifest,
  ViewMode,
} from "@changan/shared";
import { prefersLightweightScene } from "../scene/LODSelector.js";

export type LoadScope = "all" | "single";

/**
 * Whitelist for the `?color=` URL param. Anything outside this set is rejected
 * and the resolver falls back to "white". This is intentionally stricter than
 * the manifest's per-model color list so that shared links always normalise to
 * one of five canonical IDs even if a particular model is missing one (the
 * post-resolution step then tries to match against the model's actual colors).
 */
export const ALLOWED_URL_COLORS = ["white", "black", "red", "grey", "silver"] as const;
export type AllowedUrlColor = (typeof ALLOWED_URL_COLORS)[number];
const DEFAULT_URL_COLOR: AllowedUrlColor = "white";

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
  colorId: string;
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

function findColorIdCaseInsensitive(
  model: ModelDef,
  raw: string
): string | undefined {
  const lower = raw.toLowerCase();
  return model.colors.find((c) => c.id.toLowerCase() === lower)?.id;
}

/**
 * Map a `?view=` value to a bookmark index inside the model's
 * `cameraBookmarks` array, using the bookmark `visibility` flags:
 *   - `ext`   → first bookmark whose visibility.exterior is true
 *   - `trunk` → first bookmark whose visibility.detail   is true
 *   - `motor` → second bookmark whose visibility.detail  is true
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
  let detailHits = 0;
  for (let i = 0; i < bookmarks.length; i++) {
    const vis = bookmarks[i].visibility;
    if (view === "ext" && vis.exterior) return i;
    if (view === "int" && vis.interior) return i;
    if ((view === "motor" || view === "trunk") && vis.detail) {
      detailHits++;
      if (view === "trunk" && detailHits === 1) return i;
      if (view === "motor" && detailHits === 2) return i;
    }
  }
  return -1;
}

function viewModeFromBookmark(bm: NamedCameraBookmark): ViewMode {
  if (bm.visibility.interior) return "interior";
  if (bm.visibility.detail) return "detail";
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
 * **Model / color / view (new in 2026-05)**
 * - `?model=<id>`  picks a specific model. Aliased to legacy `?load=<id>`; `?load=all` keeps its
 *   special meaning (preload every car). When `model` is missing, the resolver falls back to the
 *   `fallback.modelId` (saved last view) and then to `manifest.defaults.modelId`.
 * - `?color=<white|black|red|grey|silver>` — strictly one of those five literals. Anything else
 *   falls back to `white`. If the selected model does not expose the requested color, the resolver
 *   falls back to `white`, then to that model's first color.
 * - `?view=<ext|motor|trunk|int>` — picks a programmed camera by layer ordering (see
 *   {@link bookmarkIndexForUrlView}). When set successfully, this overrides any saved bookmark
 *   index from `fallback`; when missing/invalid, the resolver returns `initialBookmarkIndex: 0`
 *   and consumers can decide whether to honour the saved index.
 *
 * **Fallback (restored from last session)**
 * - URL params always win over `fallback`. When `model` or `color` is omitted from the URL, the
 *   resolver uses the fallback if it validates against the manifest. This lets a tab reload
 *   restore the last-viewed model + color while keeping shared links deterministic.
 */
export interface ShowroomUrlFallback {
  modelId?: string;
  colorId?: string;
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
    // Scene composition is independent of quality tier: iPhones/iPads keep
    // desktop-quality splats but still load the blackdrop here.
    const lightweight = prefersLightweightScene();
    showDealership = !lightweight;
    showBackdrop = lightweight;
  } else {
    showDealership = hasDealerParam && params.get("dealer") === "1";
    showBackdrop = hasBackdropParam && params.get("backdrop") === "1";
  }

  /**
   * `model` is the new explicit alias; `load` keeps the old "all" semantics
   * and also accepts a model id for backward compat with shared links. The
   * explicit `model` wins when both are present.
   */
  const modelRaw = params.get("model");
  const loadRaw = params.get("load");

  let loadScope: LoadScope = "single";
  let modelId = manifest.defaults.modelId;

  const applyFallbackOrDefault = (): void => {
    const fallbackModelId = fallback?.modelId
      ? findModelIdCaseInsensitive(manifest, fallback.modelId)
      : undefined;
    modelId = fallbackModelId ?? manifest.defaults.modelId;
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
    const alsvin = findModelIdCaseInsensitive(manifest, "alsvin");
    modelId = alsvin ?? manifest.models[0]?.id ?? manifest.defaults.modelId;
  } else {
    const found = findModelIdCaseInsensitive(manifest, loadRaw);
    if (found) {
      modelId = found;
    } else {
      console.warn(
        `[viewer] Unknown load model "${loadRaw}", falling back to defaults / alsvin`
      );
      const alsvin = findModelIdCaseInsensitive(manifest, "alsvin");
      modelId = alsvin ?? manifest.defaults.modelId;
    }
  }

  const modelForColor = manifest.models.find((m) => m.id === modelId);

  /**
   * Color resolution. URL `?color=` is constrained to the five canonical
   * values; anything else degrades to "white". After that we project onto
   * the chosen model's actual color list (case-insensitive), falling back
   * to "white" and then the model's first color if the requested one is
   * not available on this car.
   */
  let colorId = manifest.defaults.colorId;
  const colorRaw = params.get("color");
  if (colorRaw && colorRaw.length > 0) {
    const lowered = colorRaw.toLowerCase();
    const requested = (ALLOWED_URL_COLORS as readonly string[]).includes(lowered)
      ? (lowered as AllowedUrlColor)
      : DEFAULT_URL_COLOR;
    if (requested !== lowered) {
      console.warn(
        `[viewer] Unsupported color "${colorRaw}" — only ${ALLOWED_URL_COLORS.join(", ")} are accepted; falling back to ${DEFAULT_URL_COLOR}`
      );
    }
    if (modelForColor) {
      const matched =
        findColorIdCaseInsensitive(modelForColor, requested) ??
        findColorIdCaseInsensitive(modelForColor, DEFAULT_URL_COLOR) ??
        modelForColor.colors[0]?.id;
      if (matched) colorId = matched;
    }
  } else if (fallback?.colorId && modelForColor) {
    const fallbackColor = findColorIdCaseInsensitive(modelForColor, fallback.colorId);
    if (fallbackColor) colorId = fallbackColor;
  } else if (modelForColor) {
    /**
     * No URL color, no fallback. Prefer the model's "white" if it has one
     * so the showroom always opens on a neutral color, matching the
     * specification of `?model=<id>` (defaults to white).
     */
    const white = findColorIdCaseInsensitive(modelForColor, DEFAULT_URL_COLOR);
    if (white) colorId = white;
    else if (modelForColor.colors[0]) colorId = modelForColor.colors[0].id;
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
      const bookmarks = modelForColor?.cameraBookmarks ?? [];
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
    colorId,
    viewMode,
    initialBookmarkIndex,
    urlViewExplicit,
  };
}
