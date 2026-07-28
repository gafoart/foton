import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";

// ─── Geometry helpers ──────────────────────────────────────────────────────

function colorDistance(a: THREE.Color, b: THREE.Color): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/** Point-in-polygon (ray casting). Coords are 2-element [x,y] arrays. */
function pointInPolygon(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function pointInRect(px: number, py: number, x1: number, y1: number, x2: number, y2: number): boolean {
  return px >= Math.min(x1, x2) && px <= Math.max(x1, x2) &&
         py >= Math.min(y1, y2) && py <= Math.max(y1, y2);
}

// ─── Splat projection ──────────────────────────────────────────────────────

interface ScreenPoint { x: number; y: number }

/** Project every splat center to canvas-relative CSS pixels (top-left = 0,0). */
function projectSplats(
  mesh: SplatMesh,
  camera: THREE.Camera,
  canvasRect: DOMRect
): Map<number, ScreenPoint> {
  const map = new Map<number, ScreenPoint>();
  const packed = mesh.packedSplats;
  if (!packed) return map;

  mesh.updateMatrixWorld();
  camera.updateMatrixWorld();
  const mvp = new THREE.Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .multiply(mesh.matrixWorld);
  const v = new THREE.Vector3();

  packed.forEachSplat((index, center) => {
    v.copy(center).applyMatrix4(mvp);
    if (v.z < -1 || v.z > 1) return; // clipped
    const sx = ((v.x + 1) / 2) * canvasRect.width;
    const sy = ((1 - v.y) / 2) * canvasRect.height;
    map.set(index, { x: sx, y: sy });
  });
  return map;
}

/** Find the nearest splat center (world-space) to a raycast hit point. */
function sampleNearestSplatColor(mesh: SplatMesh, hitPoint: THREE.Vector3): THREE.Color | null {
  const packed = mesh.packedSplats;
  if (!packed?.packedArray) return null;
  mesh.updateMatrixWorld();
  const invWorld = mesh.matrixWorld.clone().invert();
  const localHit = hitPoint.clone().applyMatrix4(invWorld);
  let bestDist = Infinity;
  let bestColor: THREE.Color | null = null;
  packed.forEachSplat((_i, center, _s, _q, _o, color) => {
    const d = center.distanceToSquared(localHit);
    if (d < bestDist) { bestDist = d; bestColor = color.clone(); }
  });
  return bestColor;
}

// ─── Force GPU texture refresh ─────────────────────────────────────────────

function flushPackedSplats(
  mesh: SplatMesh,
  getSpark: (() => unknown) | undefined,
): void {
  const packed = mesh.packedSplats;
  if (!packed) return;
  // Mark CPU → GPU upload needed
  packed.needsUpdate = true;
  // Call getTexture() immediately so the internal DataArrayTexture gets
  // source.needsUpdate = true set NOW (not deferred until next generate())
  packed.getTexture();
  // Bump version so SparkRenderer's accumulator regenerates
  mesh.updateVersion?.();
  // Force SparkRenderer to regenerate on the very next autoUpdate frame
  const spark = getSpark?.() as { needsUpdate: boolean } | null | undefined;
  if (spark) spark.needsUpdate = true;
}

// ─── Types ────────────────────────────────────────────────────────────────

type SelectionTool = "color" | "rect" | "lasso" | "polygon" | "brush";
const HIGHLIGHT = new THREE.Color(0x00ffff); // cyan

// ─── Panel factory ─────────────────────────────────────────────────────────

export function createColorRangePanel(options: {
  getMesh: () => SplatMesh | null;
  getCanvas: () => HTMLCanvasElement;
  getCamera: () => THREE.Camera;
  canvasContainer: HTMLElement;
  getSpark?: () => unknown;
  getScene?: () => unknown;
  getRenderer?: () => THREE.WebGLRenderer; // kept for API compat
}): { el: HTMLElement; refresh: () => void; clearSelection: () => void } {
  const { getMesh, getCanvas, getCamera, canvasContainer, getSpark } = options;

  // ── Overlay canvas for spatial selection feedback ─────────────────────────
  canvasContainer.style.position = "relative";
  const overlay = document.createElement("canvas");
  overlay.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10;";
  canvasContainer.appendChild(overlay);
  const octx = overlay.getContext("2d")!;

  const resizeOverlay = (): void => {
    overlay.width  = canvasContainer.clientWidth;
    overlay.height = canvasContainer.clientHeight;
  };
  resizeOverlay();
  new ResizeObserver(resizeOverlay).observe(canvasContainer);

  const clearOverlay = (): void => octx.clearRect(0, 0, overlay.width, overlay.height);

  // ── State ─────────────────────────────────────────────────────────────────
  let activeTool: SelectionTool = "color";
  let sampleColor: THREE.Color | null = null;
  let selectedIndices: number[] = [];
  /** packedArray snapshot taken BEFORE any highlight is applied.
   *  Restoring only the selected indices from this is enough for Unselect. */
  let cleanSnapshot: Uint32Array | null = null;
  let isSampling = false;
  let brushSize = 30; // CSS pixels

  // ── Apply / restore colors ────────────────────────────────────────────────

  const applyHighlight = (indices: number[], color: THREE.Color = HIGHLIGHT): void => {
    const mesh = getMesh();
    if (!mesh || indices.length === 0) return;
    const packed = mesh.packedSplats;
    if (!packed?.packedArray) return;
    for (const i of indices) {
      const s = packed.getSplat(i);
      packed.setSplat(i, s.center, s.scales, s.quaternion, s.opacity, color.clone());
    }
    flushPackedSplats(mesh, getSpark);
  };

  /**
   * Commit a new selection set:
   * 1. If no snapshot yet → take one now (the "clean" state).
   * 2. Restore old selected indices from snapshot (revert their cyan).
   * 3. Replace selectedIndices, apply new highlight.
   */
  const setSelection = (newIndices: number[]): void => {
    const mesh = getMesh();
    if (!mesh) return;
    const packed = mesh.packedSplats;
    if (!packed?.packedArray) return;

    // Ensure we have a clean snapshot
    if (!cleanSnapshot) {
      cleanSnapshot = packed.packedArray.slice();
    } else {
      // Revert OLD highlighted indices back to clean state
      const src = cleanSnapshot;
      const dst = packed.packedArray;
      for (const i of selectedIndices) {
        const b = i * 4;
        dst[b] = src[b]; dst[b+1] = src[b+1]; dst[b+2] = src[b+2]; dst[b+3] = src[b+3];
      }
    }

    selectedIndices = newIndices;
    updateCount();
    if (newIndices.length > 0) applyHighlight(newIndices);
    else flushPackedSplats(mesh, getSpark);
  };

  /** Additive variant used by the Brush tool. */
  const addToSelection = (newIndices: number[]): void => {
    const mesh = getMesh();
    if (!mesh) return;
    const packed = mesh.packedSplats;
    if (!packed?.packedArray) return;

    if (!cleanSnapshot) cleanSnapshot = packed.packedArray.slice();

    const set = new Set(selectedIndices);
    const added: number[] = [];
    for (const i of newIndices) {
      if (!set.has(i)) { selectedIndices.push(i); set.add(i); added.push(i); }
    }
    if (added.length > 0) applyHighlight(added);
    updateCount();
  };

  // ── Panel DOM ─────────────────────────────────────────────────────────────
  const panel = document.createElement("div");
  panel.className = "color-range-panel";
  panel.innerHTML = "<h4>Color Range</h4>";

  const body = document.createElement("div");
  body.className = "color-range-panel-body";
  panel.appendChild(body);

  // ── Tool selector ─────────────────────────────────────────────────────────
  const toolRow = document.createElement("div");
  toolRow.className = "color-range-row color-range-tools";

  const toolDefs: { id: SelectionTool; label: string; title: string }[] = [
    { id: "color",   label: "Color",   title: "Select by color similarity" },
    { id: "rect",    label: "Rect",    title: "Draw a rectangle to select" },
    { id: "lasso",   label: "Lasso",   title: "Free-draw a lasso selection" },
    { id: "polygon", label: "Poly",    title: "Click vertices to build a polygon, double-click to close" },
    { id: "brush",   label: "Brush",   title: "Paint selection with a circular brush" },
  ];

  const toolBtns: Record<SelectionTool, HTMLButtonElement> = {} as never;
  toolDefs.forEach(({ id, label, title }) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title;
    btn.className = "color-range-tool-btn";
    btn.dataset.tool = id;
    btn.addEventListener("click", () => selectTool(id));
    toolRow.appendChild(btn);
    toolBtns[id] = btn;
  });
  body.appendChild(toolRow);

  // ── Color tool rows ───────────────────────────────────────────────────────
  const colorSection = document.createElement("div");
  colorSection.className = "color-range-section";

  const sampleColorSwatch = document.createElement("div");
  sampleColorSwatch.style.cssText = "width:22px;height:22px;border-radius:4px;border:1px solid #444;flex-shrink:0;background:#333;";

  const sampleBtn = document.createElement("button");
  sampleBtn.textContent = "Pick from model";
  sampleBtn.title = "Click on the model to sample a color from the nearest splat";

  const hexInput = document.createElement("input");
  hexInput.type = "text";
  hexInput.placeholder = "#RRGGBB";
  hexInput.className = "color-range-hex";

  const sampleRow = document.createElement("div");
  sampleRow.className = "color-range-row";
  sampleRow.append(sampleColorSwatch, sampleBtn, hexInput);

  const toleranceLabel = document.createElement("label");
  toleranceLabel.textContent = "Tolerance";
  const toleranceInput = document.createElement("input");
  toleranceInput.type = "range";
  toleranceInput.min = "0";
  toleranceInput.max = "100";
  toleranceInput.value = "30";
  const toleranceValue = document.createElement("span");
  toleranceValue.textContent = "0.30";
  toleranceInput.addEventListener("input", () => {
    toleranceValue.textContent = (parseFloat(toleranceInput.value) / 100).toFixed(2);
    if (sampleColor) runColorSelect();
  });
  const tolRow = document.createElement("div");
  tolRow.className = "color-range-row";
  tolRow.append(toleranceLabel, toleranceInput, toleranceValue);

  const selectColorBtn = document.createElement("button");
  selectColorBtn.textContent = "Select by color";
  selectColorBtn.addEventListener("click", () => {
    if (sampleColor) runColorSelect();
    else alert("Sample a color first (pick from model or enter hex).");
  });

  colorSection.append(sampleRow, tolRow, selectColorBtn);

  // ── Brush size row ─────────────────────────────────────────────────────────
  const brushSection = document.createElement("div");
  brushSection.className = "color-range-section";
  const brushLabel = document.createElement("label");
  brushLabel.textContent = "Size";
  const brushSlider = document.createElement("input");
  brushSlider.type = "range";
  brushSlider.min = "5";
  brushSlider.max = "200";
  brushSlider.value = String(brushSize);
  const brushValue = document.createElement("span");
  brushValue.textContent = String(brushSize) + "px";
  brushSlider.addEventListener("input", () => {
    brushSize = parseInt(brushSlider.value);
    brushValue.textContent = brushSize + "px";
  });
  const brushRow = document.createElement("div");
  brushRow.className = "color-range-row";
  brushRow.append(brushLabel, brushSlider, brushValue);
  brushSection.appendChild(brushRow);

  // ── Count + Unselect ───────────────────────────────────────────────────────
  const countEl = document.createElement("span");
  countEl.className = "color-range-count";
  countEl.textContent = "0 selected";

  const invertBtn = document.createElement("button");
  invertBtn.textContent = "Invert";
  invertBtn.title = "Select all splats that are not currently selected";
  invertBtn.addEventListener("click", () => {
    const mesh = getMesh();
    if (!mesh) return;
    const packed = mesh.packedSplats;
    if (!packed) return;
    const sel = new Set(selectedIndices);
    const inverted: number[] = [];
    packed.forEachSplat((index) => {
      if (!sel.has(index)) inverted.push(index);
    });
    setSelection(inverted);
  });

  const unselectBtn = document.createElement("button");
  unselectBtn.textContent = "Unselect";
  unselectBtn.title = "Restore selected splats to their original colors and clear selection";
  unselectBtn.addEventListener("click", () => {
    const mesh = getMesh();
    if (!mesh || selectedIndices.length === 0 || !cleanSnapshot) {
      selectedIndices = [];
      cleanSnapshot = null;
      updateCount();
      return;
    }
    const packed = mesh.packedSplats;
    if (!packed?.packedArray) return;
    const src = cleanSnapshot;
    const dst = packed.packedArray;
    for (const i of selectedIndices) {
      const b = i * 4;
      dst[b] = src[b]; dst[b+1] = src[b+1]; dst[b+2] = src[b+2]; dst[b+3] = src[b+3];
    }
    selectedIndices = [];
    cleanSnapshot = null;
    flushPackedSplats(mesh, getSpark);
    updateCount();
  });

  const actionsRow = document.createElement("div");
  actionsRow.className = "color-range-row";
  actionsRow.append(unselectBtn, invertBtn, countEl);

  // ── New color picker ───────────────────────────────────────────────────────
  const pickerLabel = document.createElement("label");
  pickerLabel.textContent = "New color";
  const pickerInput = document.createElement("input");
  pickerInput.type = "color";
  pickerInput.value = "#ffffff";
  pickerInput.title = "Recolor selected splats in real time";
  pickerInput.addEventListener("input", () => {
    const mesh = getMesh();
    if (!mesh || selectedIndices.length === 0) return;
    const packed = mesh.packedSplats;
    if (!packed?.packedArray) return;
    const c = new THREE.Color(pickerInput.value);
    for (const i of selectedIndices) {
      const s = packed.getSplat(i);
      packed.setSplat(i, s.center, s.scales, s.quaternion, s.opacity, c.clone());
    }
    flushPackedSplats(mesh, getSpark);
  });
  const pickerRow = document.createElement("div");
  pickerRow.className = "color-range-row";
  pickerRow.append(pickerLabel, pickerInput);

  const hr = document.createElement("hr");
  body.append(colorSection, brushSection, actionsRow, hr, pickerRow);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function updateCount(): void {
    countEl.textContent =
      selectedIndices.length > 0
        ? `${selectedIndices.length.toLocaleString()} selected`
        : "0 selected";
  }

  function setSampleColor(c: THREE.Color): void {
    sampleColor = c;
    const hex = "#" + c.getHexString();
    sampleColorSwatch.style.background = hex;
    hexInput.value = hex;
  }

  function runColorSelect(): void {
    const mesh = getMesh();
    if (!mesh || !sampleColor) return;
    const packed = mesh.packedSplats;
    if (!packed) return;
    const tol = parseFloat(toleranceInput.value) / 100;
    const indices: number[] = [];
    packed.forEachSplat((index, _c, _s, _q, _o, color) => {
      if (colorDistance(sampleColor!, color) <= tol) indices.push(index);
    });
    setSelection(indices);
    pickerInput.value = "#" + sampleColor.getHexString();
  }

  // ── Pick-color sampling (Color tool) ──────────────────────────────────────
  let samplingListener: ((e: PointerEvent) => void) | null = null;

  sampleBtn.addEventListener("click", () => {
    if (isSampling) {
      isSampling = false;
      sampleBtn.textContent = "Pick from model";
      sampleBtn.classList.remove("active");
      if (samplingListener) {
        canvasContainer.removeEventListener("pointerdown", samplingListener);
        samplingListener = null;
      }
      return;
    }
    isSampling = true;
    sampleBtn.textContent = "Click on model…";
    sampleBtn.classList.add("active");
    samplingListener = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const mesh = getMesh();
      const canvas = getCanvas();
      const camera = getCamera();
      if (mesh) {
        const raycaster = new THREE.Raycaster();
        const rect = canvas.getBoundingClientRect();
        raycaster.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
          ),
          camera
        );
        const hits: { distance: number; point: THREE.Vector3; object: THREE.Object3D }[] = [];
        mesh.raycast(raycaster, hits);
        if (hits.length > 0) {
          const c = sampleNearestSplatColor(mesh, hits[0].point);
          if (c) { setSampleColor(c); runColorSelect(); }
        }
      }
      isSampling = false;
      sampleBtn.textContent = "Pick from model";
      sampleBtn.classList.remove("active");
      canvasContainer.removeEventListener("pointerdown", samplingListener!);
      samplingListener = null;
    };
    canvasContainer.addEventListener("pointerdown", samplingListener);
  });

  hexInput.addEventListener("change", () => {
    const v = hexInput.value.trim();
    if (/^#?[0-9A-Fa-f]{6}$/.test(v)) {
      setSampleColor(new THREE.Color(v.startsWith("#") ? v : `#${v}`));
      runColorSelect();
    }
  });

  // ── Spatial selection tools ───────────────────────────────────────────────

  // Shared cancel logic per tool
  let cancelCurrentTool: () => void = () => {};

  // Called when the overlay canvas should handle pointer events
  const activateOverlay = () => { overlay.style.pointerEvents = "auto"; canvasContainer.style.cursor = "crosshair"; };
  const deactivateOverlay = () => { overlay.style.pointerEvents = "none"; canvasContainer.style.cursor = ""; };

  // Convert client XY to canvas-rect-relative XY
  const toCanvasXY = (clientX: number, clientY: number): [number, number] => {
    const r = getCanvas().getBoundingClientRect();
    return [clientX - r.left, clientY - r.top];
  };

  // Select splats from projected map with a test function
  const selectFromProjection = (testFn: (x: number, y: number) => boolean): void => {
    const mesh = getMesh();
    if (!mesh) return;
    const rect = getCanvas().getBoundingClientRect();
    const projected = projectSplats(mesh, getCamera(), rect);
    const indices: number[] = [];
    projected.forEach((pt, idx) => { if (testFn(pt.x, pt.y)) indices.push(idx); });
    setSelection(indices);
    pickerInput.value = "#00ffff"; // reset picker to cyan to match highlight
  };

  // ── RECT tool ──────────────────────────────────────────────────────────────
  const setupRectTool = (): void => {
    let start: [number, number] | null = null;
    let active = false;

    const onDown = (e: PointerEvent): void => {
      if (activeTool !== "rect") return;
      if (e.button !== 0) return;
      e.preventDefault();
      [start] = [[...toCanvasXY(e.clientX, e.clientY)] as [number, number]];
      active = true;
      activateOverlay();
      overlay.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      if (!active || !start) return;
      const [cx, cy] = toCanvasXY(e.clientX, e.clientY);
      clearOverlay();
      octx.strokeStyle = "rgba(0,255,255,0.9)";
      octx.lineWidth = 1.5;
      octx.setLineDash([4, 3]);
      octx.strokeRect(start[0], start[1], cx - start[0], cy - start[1]);
    };
    const onUp = (e: PointerEvent): void => {
      if (!active || !start) return;
      active = false;
      clearOverlay();
      deactivateOverlay();
      const [cx, cy] = toCanvasXY(e.clientX, e.clientY);
      const [sx, sy] = start;
      selectFromProjection((px, py) => pointInRect(px, py, sx, sy, cx, cy));
      start = null;
    };

    canvasContainer.addEventListener("pointerdown", onDown);
    overlay.addEventListener("pointermove", onMove);
    overlay.addEventListener("pointerup", onUp);
    cancelCurrentTool = () => {
      canvasContainer.removeEventListener("pointerdown", onDown);
      overlay.removeEventListener("pointermove", onMove);
      overlay.removeEventListener("pointerup", onUp);
      active = false; start = null; deactivateOverlay();
    };
  };

  // ── LASSO tool ─────────────────────────────────────────────────────────────
  const setupLassoTool = (): void => {
    let path: [number, number][] = [];
    let active = false;

    const onDown = (e: PointerEvent): void => {
      if (activeTool !== "lasso") return;
      if (e.button !== 0) return;
      e.preventDefault();
      path = [toCanvasXY(e.clientX, e.clientY)];
      active = true;
      activateOverlay();
      overlay.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      if (!active) return;
      path.push(toCanvasXY(e.clientX, e.clientY));
      clearOverlay();
      if (path.length < 2) return;
      octx.strokeStyle = "rgba(0,255,255,0.9)";
      octx.lineWidth = 1.5;
      octx.setLineDash([]);
      octx.beginPath();
      octx.moveTo(path[0][0], path[0][1]);
      for (let i = 1; i < path.length; i++) octx.lineTo(path[i][0], path[i][1]);
      octx.stroke();
    };
    const onUp = (): void => {
      if (!active) return;
      active = false;
      clearOverlay();
      deactivateOverlay();
      if (path.length > 2) selectFromProjection((px, py) => pointInPolygon(px, py, path));
      path = [];
    };

    canvasContainer.addEventListener("pointerdown", onDown);
    overlay.addEventListener("pointermove", onMove);
    overlay.addEventListener("pointerup", onUp);
    cancelCurrentTool = () => {
      canvasContainer.removeEventListener("pointerdown", onDown);
      overlay.removeEventListener("pointermove", onMove);
      overlay.removeEventListener("pointerup", onUp);
      active = false; path = []; deactivateOverlay();
    };
  };

  // ── POLYGON tool ───────────────────────────────────────────────────────────
  const setupPolygonTool = (): void => {
    let vertices: [number, number][] = [];
    let mousePos: [number, number] = [0, 0];

    const drawPoly = (): void => {
      clearOverlay();
      if (vertices.length === 0) return;
      octx.strokeStyle = "rgba(0,255,255,0.9)";
      octx.fillStyle = "rgba(0,255,255,0.08)";
      octx.lineWidth = 1.5;
      octx.setLineDash([]);
      octx.beginPath();
      octx.moveTo(vertices[0][0], vertices[0][1]);
      for (let i = 1; i < vertices.length; i++) octx.lineTo(vertices[i][0], vertices[i][1]);
      octx.lineTo(mousePos[0], mousePos[1]);
      octx.stroke();
      // dots
      vertices.forEach(([vx, vy]) => {
        octx.beginPath();
        octx.arc(vx, vy, 3, 0, Math.PI * 2);
        octx.fillStyle = "rgba(0,255,255,0.9)";
        octx.fill();
      });
    };

    const onMouseMove = (e: MouseEvent): void => {
      if (activeTool !== "polygon") return;
      const r = getCanvas().getBoundingClientRect();
      mousePos = [e.clientX - r.left, e.clientY - r.top];
      if (vertices.length > 0) drawPoly();
    };
    const onClick = (e: MouseEvent): void => {
      if (activeTool !== "polygon") return;
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const pt = toCanvasXY(e.clientX, e.clientY);
      vertices.push(pt);
      activateOverlay();
      drawPoly();
    };
    const onDblClick = (e: MouseEvent): void => {
      if (activeTool !== "polygon") return;
      e.preventDefault(); e.stopPropagation();
      clearOverlay();
      deactivateOverlay();
      if (vertices.length > 2) selectFromProjection((px, py) => pointInPolygon(px, py, vertices));
      vertices = [];
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (activeTool !== "polygon") return;
      if (e.key === "Enter" && vertices.length > 2) {
        clearOverlay();
        deactivateOverlay();
        selectFromProjection((px, py) => pointInPolygon(px, py, vertices));
        vertices = [];
      } else if (e.key === "Escape") {
        vertices = [];
        clearOverlay();
        deactivateOverlay();
      }
    };

    canvasContainer.addEventListener("click", onClick);
    canvasContainer.addEventListener("dblclick", onDblClick);
    canvasContainer.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    cancelCurrentTool = () => {
      canvasContainer.removeEventListener("click", onClick);
      canvasContainer.removeEventListener("dblclick", onDblClick);
      canvasContainer.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      vertices = [];
      clearOverlay();
      deactivateOverlay();
    };
  };

  // ── BRUSH tool ─────────────────────────────────────────────────────────────
  const setupBrushTool = (): void => {
    let painting = false;
    let cachedProjection: Map<number, ScreenPoint> | null = null;

    const drawBrushCursor = (cx: number, cy: number): void => {
      clearOverlay();
      octx.strokeStyle = "rgba(0,255,255,0.9)";
      octx.lineWidth = 1.5;
      octx.setLineDash([3, 2]);
      octx.beginPath();
      octx.arc(cx, cy, brushSize, 0, Math.PI * 2);
      octx.stroke();
    };
    const paintAt = (cx: number, cy: number): void => {
      if (!cachedProjection) return;
      const r2 = brushSize * brushSize;
      const indices: number[] = [];
      cachedProjection.forEach((pt, idx) => {
        if ((pt.x - cx) ** 2 + (pt.y - cy) ** 2 <= r2) indices.push(idx);
      });
      if (indices.length > 0) addToSelection(indices);
    };

    const onDown = (e: PointerEvent): void => {
      if (activeTool !== "brush") return;
      if (e.button !== 0) return;
      e.preventDefault();
      const mesh = getMesh();
      if (!mesh) return;
      activateOverlay();
      canvasContainer.style.cursor = "none";
      const rect = getCanvas().getBoundingClientRect();
      cachedProjection = projectSplats(mesh, getCamera(), rect);
      painting = true;
      overlay.setPointerCapture(e.pointerId);
      const [cx, cy] = toCanvasXY(e.clientX, e.clientY);
      paintAt(cx, cy);
      drawBrushCursor(cx, cy);
    };
    const onMove = (e: PointerEvent): void => {
      const [cx, cy] = toCanvasXY(e.clientX, e.clientY);
      drawBrushCursor(cx, cy);
      if (!painting) return;
      paintAt(cx, cy);
    };
    const onUp = (): void => {
      painting = false;
      cachedProjection = null;
    };
    const onLeave = (): void => { if (!painting) clearOverlay(); };

    canvasContainer.addEventListener("pointerdown", onDown);
    overlay.addEventListener("pointermove", onMove);
    overlay.addEventListener("pointerup", onUp);
    canvasContainer.addEventListener("pointerleave", onLeave);
    // Show brush cursor when hovering even without painting
    canvasContainer.addEventListener("pointermove", (e: PointerEvent) => {
      if (activeTool !== "brush") return;
      const [cx, cy] = toCanvasXY(e.clientX, e.clientY);
      drawBrushCursor(cx, cy);
      canvasContainer.style.cursor = "none";
    });
    cancelCurrentTool = () => {
      canvasContainer.removeEventListener("pointerdown", onDown);
      overlay.removeEventListener("pointermove", onMove);
      overlay.removeEventListener("pointerup", onUp);
      canvasContainer.removeEventListener("pointerleave", onLeave);
      painting = false;
      cachedProjection = null;
      clearOverlay();
      deactivateOverlay();
    };
  };

  // ── selectTool: cancel previous handler and activate the selected tool ──────
  function selectTool(tool: SelectionTool): void {
    cancelCurrentTool();
    activeTool = tool;
    toolDefs.forEach(({ id }) => toolBtns[id].classList.toggle("active", id === tool));
    colorSection.style.display  = tool === "color"  ? "" : "none";
    brushSection.style.display  = tool === "brush"  ? "" : "none";
    clearOverlay();
    deactivateOverlay();

    if (tool === "rect")    { cancelCurrentTool = () => {}; setupRectTool(); }
    else if (tool === "lasso")   { cancelCurrentTool = () => {}; setupLassoTool(); }
    else if (tool === "polygon") { cancelCurrentTool = () => {}; setupPolygonTool(); }
    else if (tool === "brush")   { cancelCurrentTool = () => {}; setupBrushTool(); }
    else cancelCurrentTool = () => {};
  }
  // prime the first real activation
  selectTool("color");

  // ── clearSelection (external API) ─────────────────────────────────────────
  function clearSelection(): void {
    selectedIndices = [];
    cleanSnapshot = null;
    updateCount();
  }

  return {
    el: panel,
    clearSelection,
    refresh() {
      updateCount();
      if (sampleColor) {
        const hex = "#" + sampleColor.getHexString();
        sampleColorSwatch.style.background = hex;
        hexInput.value = hex;
      }
    },
  };
}
