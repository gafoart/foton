import type { SceneManifest } from "@changan/shared";

const BG_DEFAULT = "#0a0a0a";

function row(label: string, input: HTMLElement): HTMLDivElement {
  const r = document.createElement("div");
  r.className = "scene-appearance-row";
  const s = document.createElement("span");
  s.className = "scene-appearance-label";
  s.textContent = label;
  r.append(s, input);
  return r;
}

export function createSceneAppearancePanel(options: {
  getManifest: () => SceneManifest;
  onPatch: (mutator: (m: SceneManifest) => void) => void;
  applyVisuals: () => void;
  /** Effective default nameplate color (base ×15%) to seed the picker when no
   *  explicit changan3D.tint is set yet. */
  getChangan3DDefaultTint?: () => string | null;
}): { el: HTMLElement; refresh: () => void } {
  const { getManifest, onPatch, applyVisuals, getChangan3DDefaultTint } = options;

  const wrap = document.createElement("div");
  wrap.className = "scene-appearance-panel";

  const title = document.createElement("h4");
  title.textContent = "Scene & backdrop look";
  title.className = "scene-appearance-title";
  wrap.appendChild(title);

  const bgInput = document.createElement("input");
  bgInput.type = "color";
  bgInput.className = "scene-appearance-color";
  bgInput.addEventListener("input", () => {
    onPatch((m) => {
      m.scene ??= {};
      m.scene.backgroundColor = bgInput.value;
    });
    applyVisuals();
  });
  wrap.appendChild(row("Background", bgInput));

  const tintInput = document.createElement("input");
  tintInput.type = "color";
  tintInput.className = "scene-appearance-color";
  const tintStrength = document.createElement("input");
  tintStrength.type = "range";
  tintStrength.min = "0";
  tintStrength.max = "1";
  tintStrength.step = "0.02";
  tintStrength.className = "scene-appearance-range";
  const tintStrengthLbl = document.createElement("span");
  tintStrengthLbl.className = "scene-appearance-range-val";
  tintInput.addEventListener("input", () => {
    onPatch((m) => {
      m.blackdrop ??= {
        transform: { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: 1 },
      };
      m.blackdrop.tint = tintInput.value;
    });
    applyVisuals();
  });
  tintStrength.addEventListener("input", () => {
    tintStrengthLbl.textContent = Number(tintStrength.value).toFixed(2);
    onPatch((m) => {
      m.blackdrop ??= {
        transform: { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: 1 },
      };
      m.blackdrop.tintStrength = parseFloat(tintStrength.value);
    });
    applyVisuals();
  });
  const tintWrap = document.createElement("div");
  tintWrap.className = "scene-appearance-sub";
  tintWrap.appendChild(row("Backdrop tint", tintInput));
  tintWrap.appendChild(row("Tint mix", tintStrength));
  tintWrap.appendChild(tintStrengthLbl);
  wrap.appendChild(tintWrap);

  // 3D nameplates (changan3D.glb) absolute color. Left unset, they render at
  // base albedo ×15% (lighter gray); picking a color writes an absolute hex.
  const npInput = document.createElement("input");
  npInput.type = "color";
  npInput.className = "scene-appearance-color";
  npInput.addEventListener("input", () => {
    onPatch((m) => {
      m.changan3D ??= {
        transform: { pos: [0, 0.2, 1.4], rot: [0, 0, 0, 1], scale: 1 },
      };
      m.changan3D.tint = npInput.value;
    });
    applyVisuals();
  });
  const npWrap = document.createElement("div");
  npWrap.className = "scene-appearance-sub";
  npWrap.appendChild(row("Nameplates 3D", npInput));
  wrap.appendChild(npWrap);

  const ambColor = document.createElement("input");
  ambColor.type = "color";
  ambColor.className = "scene-appearance-color";
  const ambInt = document.createElement("input");
  ambInt.type = "number";
  ambInt.step = "0.05";
  ambInt.min = "0";
  ambInt.className = "scene-appearance-num";
  const ambChange = () => {
    onPatch((m) => {
      m.scene ??= {};
      m.scene.lighting ??= {};
      m.scene.lighting.ambient = {
        color: ambColor.value,
        intensity: parseFloat(ambInt.value) || 0,
      };
    });
    applyVisuals();
  };
  ambColor.addEventListener("input", ambChange);
  ambInt.addEventListener("change", ambChange);
  const ambWrap = document.createElement("div");
  ambWrap.className = "scene-appearance-sub";
  ambWrap.innerHTML = "<div class=\"scene-appearance-subtitle\">Ambient light</div>";
  ambWrap.appendChild(row("Color", ambColor));
  ambWrap.appendChild(row("Intensity", ambInt));
  wrap.appendChild(ambWrap);

  const dirColor = document.createElement("input");
  dirColor.type = "color";
  dirColor.className = "scene-appearance-color";
  const dirInt = document.createElement("input");
  dirInt.type = "number";
  dirInt.step = "0.05";
  dirInt.min = "0";
  dirInt.className = "scene-appearance-num";
  const dirX = document.createElement("input");
  const dirY = document.createElement("input");
  const dirZ = document.createElement("input");
  for (const i of [dirX, dirY, dirZ]) {
    i.type = "number";
    i.step = "0.5";
    i.className = "scene-appearance-num scene-appearance-num-sm";
  }
  const dirChange = () => {
    onPatch((m) => {
      m.scene ??= {};
      m.scene.lighting ??= {};
      m.scene.lighting.directional = {
        color: dirColor.value,
        intensity: parseFloat(dirInt.value) || 0,
        pos: [
          parseFloat(dirX.value) || 0,
          parseFloat(dirY.value) || 0,
          parseFloat(dirZ.value) || 0,
        ],
      };
    });
    applyVisuals();
  };
  dirColor.addEventListener("input", dirChange);
  dirInt.addEventListener("change", dirChange);
  dirX.addEventListener("change", dirChange);
  dirY.addEventListener("change", dirChange);
  dirZ.addEventListener("change", dirChange);
  const dirWrap = document.createElement("div");
  dirWrap.className = "scene-appearance-sub";
  dirWrap.innerHTML = "<div class=\"scene-appearance-subtitle\">Directional light</div>";
  dirWrap.appendChild(row("Color", dirColor));
  dirWrap.appendChild(row("Intensity", dirInt));
  const posRow = document.createElement("div");
  posRow.className = "scene-appearance-row scene-appearance-pos-row";
  posRow.innerHTML = "<span class=\"scene-appearance-label\">Position</span>";
  posRow.append(dirX, dirY, dirZ);
  dirWrap.appendChild(posRow);
  wrap.appendChild(dirWrap);

  const fogEn = document.createElement("input");
  fogEn.type = "checkbox";
  fogEn.id = "scene-fog-enabled";
  const fogColor = document.createElement("input");
  fogColor.type = "color";
  fogColor.className = "scene-appearance-color";
  const fogNear = document.createElement("input");
  const fogFar = document.createElement("input");
  fogNear.type = "number";
  fogFar.type = "number";
  fogNear.step = "0.5";
  fogFar.step = "1";
  fogNear.className = "scene-appearance-num";
  fogFar.className = "scene-appearance-num";
  const fogChange = () => {
    onPatch((m) => {
      m.scene ??= {};
      m.scene.lighting ??= {};
      m.scene.lighting.fog = {
        enabled: fogEn.checked,
        color: fogColor.value,
        near: parseFloat(fogNear.value) || 0,
        far: parseFloat(fogFar.value) || 0,
      };
    });
    applyVisuals();
  };
  fogEn.addEventListener("change", fogChange);
  fogColor.addEventListener("input", fogChange);
  fogNear.addEventListener("change", fogChange);
  fogFar.addEventListener("change", fogChange);
  const fogWrap = document.createElement("div");
  fogWrap.className = "scene-appearance-sub";
  const fogTitle = document.createElement("div");
  fogTitle.className = "scene-appearance-subtitle";
  fogTitle.textContent = "Depth fog (backdrop softness)";
  fogWrap.appendChild(fogTitle);
  const enRow = document.createElement("div");
  enRow.className = "scene-appearance-row";
  const enLbl = document.createElement("label");
  enLbl.htmlFor = "scene-fog-enabled";
  enLbl.textContent = "Enable fog";
  enRow.append(fogEn, enLbl);
  fogWrap.appendChild(enRow);
  fogWrap.appendChild(row("Fog color", fogColor));
  fogWrap.appendChild(row("Near", fogNear));
  fogWrap.appendChild(row("Far", fogFar));
  wrap.appendChild(fogWrap);

  const hint = document.createElement("p");
  hint.className = "scene-appearance-hint";
  hint.textContent =
    "Tint tints the GLB backdrop. Fog adds distance haze. Save to project to persist.";
  wrap.appendChild(hint);

  function refresh(): void {
    const m = getManifest();
    const sc = m.scene;
    const lit = sc?.lighting;
    const fog = lit?.fog;

    bgInput.value =
      sc?.backgroundColor && /^#[0-9a-fA-F]{6}$/.test(sc.backgroundColor)
        ? sc.backgroundColor
        : BG_DEFAULT;

    const bd = m.blackdrop;
    tintInput.value =
      bd?.tint && /^#[0-9a-fA-F]{6}$/.test(bd.tint) ? bd.tint : "#ffffff";
    const ts = bd?.tintStrength ?? 0;
    tintStrength.value = String(ts);
    tintStrengthLbl.textContent = ts.toFixed(2);

    const npTint = m.changan3D?.tint;
    npInput.value =
      npTint && /^#[0-9a-fA-F]{6}$/.test(npTint)
        ? npTint
        : getChangan3DDefaultTint?.() ?? "#cccccc";

    const amb = lit?.ambient ?? { color: "#ffffff", intensity: 0.4 };
    ambColor.value = /^#[0-9a-fA-F]{6}$/.test(amb.color) ? amb.color : "#ffffff";
    ambInt.value = String(amb.intensity);

    const dir = lit?.directional ?? {
      color: "#ffffff",
      intensity: 0.9,
      pos: [6, 12, 8] as [number, number, number],
    };
    dirColor.value = /^#[0-9a-fA-F]{6}$/.test(dir.color) ? dir.color : "#ffffff";
    dirInt.value = String(dir.intensity);
    dirX.value = String(dir.pos[0]);
    dirY.value = String(dir.pos[1]);
    dirZ.value = String(dir.pos[2]);

    fogEn.checked = fog?.enabled === true;
    fogColor.value =
      fog?.color && /^#[0-9a-fA-F]{6}$/.test(fog.color) ? fog.color : BG_DEFAULT;
    fogNear.value = String(fog?.near ?? 8);
    fogFar.value = String(fog?.far ?? 40);
  }

  refresh();

  return { el: wrap, refresh };
}
