import type { SceneManifest, TransformDef } from "./types.js";

export const DEFAULT_CONTACT_SHADOW_TRANSFORM: TransformDef = {
  pos: [0, 0.04, 0],
  rot: [0, 0, 0, 1],
  scale: [2.5, 2.5, 2.5],
  pivot: [0, 0, 0],
  pivotRot: [0, 0, 0, 1],
};

/** Resolved radial gradient (matches previous hardcoded disk look by default). */
export interface ContactShadowGradientResolved {
  centerAlpha: number;
  midStop: number;
  midAlpha: number;
  edgeAlpha: number;
}

export const DEFAULT_CONTACT_SHADOW_GRADIENT: ContactShadowGradientResolved = {
  centerAlpha: 0.5,
  midStop: 0.42,
  midAlpha: 0.16,
  edgeAlpha: 0,
};

/** Default normalized corner radius (see `ModelDef.contactShadow.cornerRadius`). */
export const DEFAULT_CONTACT_SHADOW_CORNER_RADIUS = 0.22;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Merge manifest `contactShadow.gradient` with defaults (safe for runtime + editor). */
/** 0–1 factor of min(local half-width, half-depth); local half-extents are 1×1 for the blob mesh. */
export function resolveContactShadowCornerRadius(partial?: number): number {
  return clamp01(partial ?? DEFAULT_CONTACT_SHADOW_CORNER_RADIUS);
}

export function resolveContactShadowGradient(
  partial?: {
    centerAlpha?: number;
    midStop?: number;
    midAlpha?: number;
    edgeAlpha?: number;
  }
): ContactShadowGradientResolved {
  const midStopRaw = partial?.midStop ?? DEFAULT_CONTACT_SHADOW_GRADIENT.midStop;
  const midStop = Math.min(0.999, Math.max(0.02, midStopRaw));
  return {
    centerAlpha: clamp01(partial?.centerAlpha ?? DEFAULT_CONTACT_SHADOW_GRADIENT.centerAlpha),
    midStop,
    midAlpha: clamp01(partial?.midAlpha ?? DEFAULT_CONTACT_SHADOW_GRADIENT.midAlpha),
    edgeAlpha: clamp01(partial?.edgeAlpha ?? DEFAULT_CONTACT_SHADOW_GRADIENT.edgeAlpha),
  };
}

/** Ensures every model has `contactShadow` so the editor layers + viewer can use it. */
export function ensureContactShadowDefaults(manifest: SceneManifest): void {
  for (const m of manifest.models) {
    if (!m.contactShadow) {
      m.contactShadow = {
        transform: { ...DEFAULT_CONTACT_SHADOW_TRANSFORM },
        opacity: 0.9,
        cornerRadius: DEFAULT_CONTACT_SHADOW_CORNER_RADIUS,
        gradient: {},
      };
    } else {
      if (m.contactShadow.opacity === undefined) {
        m.contactShadow.opacity = 0.9;
      }
      if (m.contactShadow.cornerRadius === undefined) {
        m.contactShadow.cornerRadius = DEFAULT_CONTACT_SHADOW_CORNER_RADIUS;
      }
      if (m.contactShadow.gradient === undefined) {
        m.contactShadow.gradient = {};
      }
    }
  }
}
