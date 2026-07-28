import * as THREE from "three";
import type { TransformDef } from "@changan/shared";
import { getScale } from "@changan/shared";

function quatToEulerDeg(quat: [number, number, number, number]): [number, number, number] {
  const e = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion(quat[0], quat[1], quat[2], quat[3])
  );
  return [
    THREE.MathUtils.radToDeg(e.x),
    THREE.MathUtils.radToDeg(e.y),
    THREE.MathUtils.radToDeg(e.z),
  ];
}

function eulerDegToQuat(deg: [number, number, number]): [number, number, number, number] {
  const e = new THREE.Euler(
    THREE.MathUtils.degToRad(deg[0]),
    THREE.MathUtils.degToRad(deg[1]),
    THREE.MathUtils.degToRad(deg[2]),
    "XYZ"
  );
  const q = new THREE.Quaternion().setFromEuler(e);
  return [q.x, q.y, q.z, q.w];
}

function createNumInput(
  label: string,
  value: number,
  onChange: (v: number) => void
): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = document.createElement("div");
  row.className = "transform-param-row";
  const span = document.createElement("span");
  span.className = "transform-param-label";
  span.textContent = label;
  const inp = document.createElement("input");
  inp.type = "number";
  inp.step = "any";
  inp.value = String(value);
  inp.className = "transform-param-input";
  row.append(span, inp);

  const commit = () => {
    const parsed = parseFloat(inp.value);
    if (!Number.isNaN(parsed)) {
      onChange(parsed);
    }
  };
  inp.addEventListener("change", commit);
  inp.addEventListener("blur", commit);

  return { row, input: inp };
}

export function createTransformParamsPanel(options: {
  getTransform: () => TransformDef | null;
  onTransformChange: (transform: Partial<TransformDef>) => void;
  onPivotChange?: (pivot: [number, number, number], pivotRot?: [number, number, number, number]) => void;
  getPivotData?: () => { pivot: [number, number, number]; pivotRot: [number, number, number, number] } | null;
}): { el: HTMLElement; refresh: () => void } {
  const { getTransform, onTransformChange, onPivotChange, getPivotData } = options;

  const panel = document.createElement("div");
  panel.className = "transform-params-panel";

  // Position
  const posSection = document.createElement("div");
  posSection.className = "transform-params-section";
  posSection.innerHTML = "<h4>Position</h4>";
  const posX = createNumInput("X", 0, (v) => {
    const t = getTransform();
    if (t) onTransformChange({ pos: [v, t.pos[1], t.pos[2]] });
  });
  const posY = createNumInput("Y", 0, (v) => {
    const t = getTransform();
    if (t) onTransformChange({ pos: [t.pos[0], v, t.pos[2]] });
  });
  const posZ = createNumInput("Z", 0, (v) => {
    const t = getTransform();
    if (t) onTransformChange({ pos: [t.pos[0], t.pos[1], v] });
  });
  posSection.append(posX.row, posY.row, posZ.row);

  // Rotation (Euler degrees XYZ)
  const rotSection = document.createElement("div");
  rotSection.className = "transform-params-section";
  rotSection.innerHTML = "<h4>Rotation (°)</h4>";
  const rotX = createNumInput("X", 0, (v) => {
    const t = getTransform();
    if (t) {
      const deg = quatToEulerDeg(t.rot);
      const q = eulerDegToQuat([v, deg[1], deg[2]]);
      onTransformChange({ rot: q });
    }
  });
  const rotY = createNumInput("Y", 0, (v) => {
    const t = getTransform();
    if (t) {
      const deg = quatToEulerDeg(t.rot);
      const q = eulerDegToQuat([deg[0], v, deg[2]]);
      onTransformChange({ rot: q });
    }
  });
  const rotZ = createNumInput("Z", 0, (v) => {
    const t = getTransform();
    if (t) {
      const deg = quatToEulerDeg(t.rot);
      const q = eulerDegToQuat([deg[0], deg[1], v]);
      onTransformChange({ rot: q });
    }
  });
  rotSection.append(rotX.row, rotY.row, rotZ.row);

  // Scale
  const scaleSection = document.createElement("div");
  scaleSection.className = "transform-params-section";
  scaleSection.innerHTML = "<h4>Scale</h4>";
  const scaleX = createNumInput("X", 1, (v) => {
    const t = getTransform();
    if (t) {
      const [_, sy, sz] = getScale(t);
      onTransformChange({ scale: [v, sy, sz] });
    }
  });
  const scaleY = createNumInput("Y", 1, (v) => {
    const t = getTransform();
    if (t) {
      const [sx, _, sz] = getScale(t);
      onTransformChange({ scale: [sx, v, sz] });
    }
  });
  const scaleZ = createNumInput("Z", 1, (v) => {
    const t = getTransform();
    if (t) {
      const [sx, sy] = getScale(t);
      onTransformChange({ scale: [sx, sy, v] });
    }
  });
  scaleSection.append(scaleX.row, scaleY.row, scaleZ.row);

  // Pivot
  const pivotSection = document.createElement("div");
  pivotSection.className = "transform-params-section";
  pivotSection.innerHTML = "<h4>Pivot</h4>";
  const pivotX = createNumInput("X", 0, (v) => {
    const data = getPivotData?.();
    if (data && onPivotChange) onPivotChange([v, data.pivot[1], data.pivot[2]], data.pivotRot);
  });
  const pivotY = createNumInput("Y", 0, (v) => {
    const data = getPivotData?.();
    if (data && onPivotChange) onPivotChange([data.pivot[0], v, data.pivot[2]], data.pivotRot);
  });
  const pivotZ = createNumInput("Z", 0, (v) => {
    const data = getPivotData?.();
    if (data && onPivotChange) onPivotChange([data.pivot[0], data.pivot[1], v], data.pivotRot);
  });
  pivotSection.append(pivotX.row, pivotY.row, pivotZ.row);

  panel.append(posSection, rotSection, scaleSection, pivotSection);

  function refresh() {
    const t = getTransform();
    if (t) {
      posX.input.value = String(t.pos[0]);
      posY.input.value = String(t.pos[1]);
      posZ.input.value = String(t.pos[2]);
      const deg = quatToEulerDeg(t.rot);
      rotX.input.value = String(deg[0].toFixed(2));
      rotY.input.value = String(deg[1].toFixed(2));
      rotZ.input.value = String(deg[2].toFixed(2));
      const [sx, sy, sz] = getScale(t);
      scaleX.input.value = String(sx);
      scaleY.input.value = String(sy);
      scaleZ.input.value = String(sz);
    }
    const pivotData = getPivotData?.();
    if (pivotData) {
      pivotX.input.value = String(pivotData.pivot[0]);
      pivotY.input.value = String(pivotData.pivot[1]);
      pivotZ.input.value = String(pivotData.pivot[2]);
    }
  }

  return { el: panel, refresh };
}
