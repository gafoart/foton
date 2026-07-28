export type LOD = "mobile" | "desktop";

export interface QualityProfile {
  lod: LOD;
  maxSplats: number | undefined;
  maxSh: 0 | 1 | 2 | 3;
  pixelRatio: number;
  interactionMaxSh: 0 | 1 | 2 | 3;
  interactionPixelRatio: number;
}

/**
 * iPhone/iPod/iPad detection (including iPadOS 13+, which spoofs `MacIntel`).
 * Used to keep Apple touch devices on the desktop quality profile — they have
 * enough GPU headroom that the mobile downgrade just makes the experience
 * look worse for no reason. Desktop macOS is excluded via the touch check.
 */
function isAppleMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  if (/iPhone|iPod|iPad/.test(platform)) return true;
  if (platform === "MacIntel" && typeof document !== "undefined" && "ontouchend" in document) {
    return true;
  }
  return false;
}

/**
 * Decide LOD based on screen size, device memory, URL param, and platform.
 * iOS/iPadOS always get desktop quality unless the URL forces mobile.
 */
export function getLOD(): LOD {
  const params = new URLSearchParams(window.location.search);
  const param = params.get("lod");
  if (param === "mobile" || param === "desktop") return param;

  const isMobileWidth = typeof window !== "undefined" && window.innerWidth < 900;
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const lowMemory =
    typeof navigator !== "undefined" &&
    "deviceMemory" in navigator &&
    dm !== undefined &&
    dm <= 4;

  if (isMobileWidth || lowMemory) {
    return isAppleMobile() ? "desktop" : "mobile";
  }
  return "desktop";
}

/**
 * Whether to load the lightweight blackdrop scene instead of the full dealership
 * splat. Independent of the quality tier: iPhones/iPads keep desktop-quality
 * splats but still get the blackdrop here because the room scene doesn't read
 * well on a small screen and the bandwidth saving matters on cellular.
 */
export function prefersLightweightScene(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < 900 || isAppleMobile();
}

const DESKTOP_PROFILE: QualityProfile = {
  lod: "desktop",
  maxSplats: undefined,
  maxSh: 3,
  pixelRatio: Math.min(
    typeof window !== "undefined" ? window.devicePixelRatio : 1,
    2
  ),
  interactionMaxSh: 3,
  interactionPixelRatio: Math.min(
    typeof window !== "undefined" ? window.devicePixelRatio : 1,
    2
  ),
};

const MOBILE_PROFILE: QualityProfile = {
  lod: "mobile",
  maxSplats: 500_000,
  maxSh: 1,
  pixelRatio: 1,
  interactionMaxSh: 0,
  interactionPixelRatio: 1,
};

export function getQualityProfile(): QualityProfile {
  const lod = getLOD();
  const profile = { ...(lod === "mobile" ? MOBILE_PROFILE : DESKTOP_PROFILE) };

  const params = new URLSearchParams(window.location.search);
  const maxSplatsParam = params.get("maxSplats");
  if (maxSplatsParam) {
    const n = parseInt(maxSplatsParam, 10);
    if (Number.isFinite(n) && n > 0) profile.maxSplats = n;
  }
  const maxShParam = params.get("maxSh");
  if (maxShParam) {
    const n = parseInt(maxShParam, 10);
    if (n >= 0 && n <= 3) profile.maxSh = n as 0 | 1 | 2 | 3;
  }

  return profile;
}

/**
 * Resolve asset URL with LOD. Uses lod.mobile or lod.desktop if present.
 */
export function resolveAssetUrl(
  asset: { url: string; lod?: { mobile?: string; desktop?: string } },
  lod: LOD
): string {
  const lodUrl = asset.lod?.[lod];
  return lodUrl ?? asset.url;
}
