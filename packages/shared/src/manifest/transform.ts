import type { TransformDef } from "./types.js";

export const DEFAULT_TRANSFORM: TransformDef = {
  pos: [0, 0, 0],
  rot: [0, 0, 0, 1],
  scale: 1,
  pivot: [0, 0, 0],
  pivotRot: [0, 0, 0, 1],
};

export function getPivot(t: TransformDef): [number, number, number] {
  return t.pivot ?? [0, 0, 0];
}

export function getPivotRot(t: TransformDef): [number, number, number, number] {
  return t.pivotRot ?? [0, 0, 0, 1];
}

export function getScale(t: TransformDef): [number, number, number] {
  const s = t.scale;
  return typeof s === "number" ? [s, s, s] : [s[0], s[1], s[2]];
}
