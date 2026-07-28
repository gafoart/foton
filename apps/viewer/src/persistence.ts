/**
 * localStorage-backed snapshot of "where the user last was" so that a tab
 * reload (manual refresh, mobile OOM kill, accidental swipe) brings them
 * back to the same model + color + bookmark instead of the default landing
 * state. URL params (`?load=`, `?color=`) still override this so shared
 * links remain deterministic.
 */
import type { ViewMode } from "@changan/shared";

export interface PersistedView {
  modelId: string;
  colorId: string;
  viewMode: ViewMode;
  bookmarkIndex: number;
  savedAt: number;
}

const KEY = "changan:lastView:v1";
/**
 * 24 h TTL — long enough to survive an iOS OOM kill or commute-time tab
 * suspend, short enough that returning the next day or week lands on the
 * configured defaults instead of a stale browsing session.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    /** Safari private mode + some embedded webviews throw on access. */
    return null;
  }
}

export function saveLastView(
  view: Omit<PersistedView, "savedAt">
): void {
  const s = storage();
  if (!s) return;
  try {
    const payload: PersistedView = { ...view, savedAt: Date.now() };
    s.setItem(KEY, JSON.stringify(payload));
  } catch {
    /** QuotaExceeded — fine, we'll skip persistence this session. */
  }
}

export function loadLastView(): PersistedView | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedView>;
    if (
      typeof parsed.modelId !== "string" ||
      typeof parsed.colorId !== "string" ||
      typeof parsed.viewMode !== "string" ||
      typeof parsed.bookmarkIndex !== "number" ||
      typeof parsed.savedAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      s.removeItem(KEY);
      return null;
    }
    return parsed as PersistedView;
  } catch {
    return null;
  }
}

export function clearLastView(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(KEY);
  } catch {
    /** ignore */
  }
}
