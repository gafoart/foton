import type { Spherical, Vector3 } from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * Clears OrbitControls internal motion (damping deltas, pan, dolly scale).
 * Call when switching to fixed-look / free-look so skipped update() frames do not
 * leave stale inertia that jerks the camera when orbit resumes.
 */
export function clearOrbitControlsTransientState(controls: OrbitControls): void {
  const c = controls as OrbitControls & {
    _sphericalDelta: Spherical;
    _panOffset: Vector3;
    _scale: number;
  };
  c._sphericalDelta.set(0, 0, 0);
  c._panOffset.set(0, 0, 0);
  c._scale = 1;
}
