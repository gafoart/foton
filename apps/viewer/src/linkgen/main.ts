/**
 * Standalone link-generator page (/linkgen). Lets internal users build a
 * deep link to the showroom by picking model + color + view + scene options
 * with visual controls. Renders into #linkgen-app and stays decoupled from
 * the main viewer bundle — no three.js, no Spark, no scene runtime.
 *
 * URL params produced here match the contract in
 * `src/showroom/urlParams.ts`:
 *   - ?model=<id>
 *   - ?color=<white|black|red|grey|silver>  (omitted when white = default)
 *   - ?view=<ext|trunk|motor|int>
 *   - ?dealer=1
 *   - ?backdrop=1
 *   - ?load=all
 */
import type { ModelDef, SceneManifest } from "@changan/shared";
import { resolveSwatchHex, validateManifestSafe } from "@changan/shared";
import { type UrlViewParam } from "../showroom/urlParams.js";
import "./style.css";

/**
 * Legacy canonical `?color=` values. The showroom no longer consumes a color
 * URL param (colors are dormant in the FOTON manifest), but this internal
 * page keeps emitting them for backwards compatibility with old links; models
 * without declared colors simply show every dot disabled.
 */
const ALLOWED_URL_COLORS = ["white", "black", "red", "grey", "silver"] as const;
type AllowedUrlColor = (typeof ALLOWED_URL_COLORS)[number];

const THUMBNAIL_MAP: Record<string, string> = {
  alsvin: "/thumbnails/alsvin.png",
  cs35: "/thumbnails/cs35.png",
  cs55: "/thumbnails/cs55.png",
  cs95: "/thumbnails/cs95.png",
  "hunter-d": "/thumbnails/hunterDisel.png",
  "hunter-g": "/thumbnails/hunterGasolina.png",
};

const DISPLAY_NAMES: Record<string, string> = {
  alsvin: "ALSVIN",
  cs35: "CS35",
  cs55: "CS55",
  cs95: "CS95",
  "hunter-d": "HUNTER",
  "hunter-g": "HUNTER PLUS",
};

const VIEW_OPTIONS: ReadonlyArray<{ value: UrlViewParam | ""; label: string }> = [
  { value: "", label: "Por defecto" },
  { value: "ext", label: "Exterior" },
  { value: "trunk", label: "Trunk" },
  { value: "motor", label: "Motor" },
  { value: "int", label: "Interior" },
];

/**
 * Scene fondo selection. `dealer` and `backdrop` are mutually exclusive in
 * the showroom resolver (you can't have both visible), so the UI exposes a
 * single dropdown rather than two checkboxes. `""` keeps the URL clean and
 * lets the device-specific default win (mobile → backdrop, desktop → dealer).
 */
type SceneFondo = "" | "dealer" | "backdrop";

type LodOption = "" | "mobile" | "desktop";

interface LinkState {
  modelId: string;
  colorId: AllowedUrlColor;
  view: UrlViewParam | "";
  fondo: SceneFondo;
  loadAll: boolean;
  lod: LodOption;
  maxSplats: string;
  maxSh: string;
  stats: boolean;
  domain: string;
}

async function fetchManifest(): Promise<SceneManifest> {
  /**
   * The link generator is a low-traffic page; we always hit /api/manifest
   * (with the static public/manifest.json as a last-resort fallback). The
   * SSR inlining on `/` doesn't apply here, so there is no script tag to
   * read from.
   */
  const candidates = import.meta.env.DEV
    ? ["/manifest.json"]
    : ["/api/manifest", "/manifest.json"];
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const parsed = validateManifestSafe(data);
      if (parsed.success) return parsed.data;
      console.warn(`[linkgen] manifest at ${url} failed validation`, parsed.error.issues);
    } catch (err) {
      console.warn(`[linkgen] fetch ${url} failed`, err);
    }
  }
  throw new Error("No se pudo cargar el manifest.");
}

function modelHasColor(model: ModelDef, colorId: AllowedUrlColor): boolean {
  return (model.colors ?? []).some((c) => c.id.toLowerCase() === colorId);
}

function resolveInitialColor(model: ModelDef): AllowedUrlColor {
  if (modelHasColor(model, "white")) return "white";
  for (const c of ALLOWED_URL_COLORS) {
    if (modelHasColor(model, c)) return c;
  }
  return "white";
}

function buildUrl(state: LinkState): string {
  const params = new URLSearchParams();
  params.set("model", state.modelId);
  if (state.colorId !== "white") params.set("color", state.colorId);
  if (state.view) params.set("view", state.view);
  if (state.fondo === "dealer") params.set("dealer", "1");
  else if (state.fondo === "backdrop") params.set("backdrop", "1");
  if (state.loadAll) params.set("load", "all");
  if (state.lod) params.set("lod", state.lod);
  if (state.maxSplats) params.set("maxSplats", state.maxSplats);
  if (state.maxSh) params.set("maxSh", state.maxSh);
  if (state.stats) params.set("stats", "1");

  const base = state.domain.trim().replace(/\/+$/, "");
  const qs = params.toString();
  return `${base}/${qs ? `?${qs}` : ""}`;
}

function renderApp(root: HTMLElement, manifest: SceneManifest): void {
  const defaultModelId =
    manifest.models.find((m) => m.id === manifest.defaults.modelId)?.id ??
    manifest.models[0]?.id ??
    "";
  const defaultModel =
    manifest.models.find((m) => m.id === defaultModelId) ?? manifest.models[0];
  if (!defaultModel) {
    root.innerHTML =
      '<div class="linkgen-error">El manifest no tiene modelos disponibles.</div>';
    return;
  }

  const state: LinkState = {
    modelId: defaultModel.id,
    colorId: resolveInitialColor(defaultModel),
    view: "",
    fondo: "",
    loadAll: false,
    lod: "",
    maxSplats: "",
    maxSh: "",
    stats: false,
    domain: window.location.origin,
  };

  const shell = document.createElement("div");
  shell.className = "linkgen-shell";

  /** Header */
  const header = document.createElement("div");
  header.className = "linkgen-header";
  const titleWrap = document.createElement("div");
  const title = document.createElement("h1");
  title.className = "linkgen-title";
  title.textContent = "Generador de Enlaces";
  const subtitle = document.createElement("p");
  subtitle.className = "linkgen-subtitle";
  subtitle.textContent =
    "Configura modelo, color, vista y escena. El URL se actualiza en tiempo real.";
  titleWrap.append(title, subtitle);
  const navWrap = document.createElement("div");
  navWrap.className = "linkgen-nav";
  const showroomLink = document.createElement("a");
  showroomLink.href = "/";
  showroomLink.className = "linkgen-back";
  showroomLink.textContent = "← Showroom";
  const manualLink = document.createElement("a");
  manualLink.href = "/product";
  manualLink.className = "linkgen-back";
  manualLink.textContent = "Manual";
  navWrap.append(showroomLink, manualLink);
  header.append(titleWrap, navWrap);
  shell.appendChild(header);

  /** Domain (editable) */
  const domainSection = document.createElement("div");
  domainSection.className = "linkgen-section";
  const domainLabel = document.createElement("p");
  domainLabel.className = "linkgen-section-label";
  domainLabel.textContent = "Dominio base";
  const domainInput = document.createElement("input");
  domainInput.className = "linkgen-domain-input";
  domainInput.type = "text";
  domainInput.value = state.domain;
  domainInput.spellcheck = false;
  domainInput.addEventListener("input", () => {
    state.domain = domainInput.value;
    renderOutput();
  });
  domainSection.append(domainLabel, domainInput);
  shell.appendChild(domainSection);

  /** Models */
  const modelSection = document.createElement("div");
  modelSection.className = "linkgen-section";
  const modelLabel = document.createElement("p");
  modelLabel.className = "linkgen-section-label";
  modelLabel.textContent = "Modelo";
  const modelGrid = document.createElement("div");
  modelGrid.className = "linkgen-model-grid";
  const modelButtons: HTMLButtonElement[] = [];
  for (const m of manifest.models) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "linkgen-model-card";
    btn.dataset.modelId = m.id;
    const img = document.createElement("img");
    img.src = THUMBNAIL_MAP[m.id] ?? "";
    img.alt = m.name;
    img.loading = "lazy";
    const nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.textContent = DISPLAY_NAMES[m.id] ?? m.name;
    btn.append(img, nameEl);
    btn.addEventListener("click", () => {
      if (state.modelId === m.id) return;
      state.modelId = m.id;
      /** Re-anchor to white when the previous color isn't available here. */
      if (!modelHasColor(m, state.colorId)) {
        state.colorId = resolveInitialColor(m);
      }
      renderModels();
      renderColors();
      renderOutput();
    });
    modelGrid.appendChild(btn);
    modelButtons.push(btn);
  }
  modelSection.append(modelLabel, modelGrid);
  shell.appendChild(modelSection);

  /** Colors */
  const colorSection = document.createElement("div");
  colorSection.className = "linkgen-section";
  const colorLabel = document.createElement("p");
  colorLabel.className = "linkgen-section-label";
  colorLabel.textContent = "Color";
  const colorRow = document.createElement("div");
  colorRow.className = "linkgen-color-row";
  colorSection.append(colorLabel, colorRow);
  shell.appendChild(colorSection);

  /** View */
  const viewSection = document.createElement("div");
  viewSection.className = "linkgen-section";
  const viewLabel = document.createElement("p");
  viewLabel.className = "linkgen-section-label";
  viewLabel.textContent = "Vista";
  const viewRow = document.createElement("div");
  viewRow.className = "linkgen-pill-row";
  const viewButtons: HTMLButtonElement[] = [];
  for (const opt of VIEW_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "linkgen-pill";
    btn.dataset.value = opt.value;
    btn.textContent = opt.label;
    btn.addEventListener("click", () => {
      state.view = opt.value;
      renderViews();
      renderOutput();
    });
    viewRow.appendChild(btn);
    viewButtons.push(btn);
  }
  viewSection.append(viewLabel, viewRow);
  shell.appendChild(viewSection);

  /** Scene fondo (mutually-exclusive dropdown) + load scope */
  const sceneSection = document.createElement("div");
  sceneSection.className = "linkgen-section";
  const sceneLabel = document.createElement("p");
  sceneLabel.className = "linkgen-section-label";
  sceneLabel.textContent = "Escena";

  const fondoField = document.createElement("div");
  fondoField.className = "linkgen-field";
  const fondoFieldLabel = document.createElement("label");
  fondoFieldLabel.className = "linkgen-field-label";
  fondoFieldLabel.textContent = "Fondo";
  const fondoSelect = document.createElement("select");
  fondoSelect.className = "linkgen-select";
  for (const opt of [
    { value: "", label: "Automático (según dispositivo)" },
    { value: "dealer", label: "Dealership (?dealer=1)" },
    { value: "backdrop", label: "Backdrop (?backdrop=1)" },
  ] as const) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    fondoSelect.appendChild(option);
  }
  fondoSelect.value = state.fondo;
  fondoFieldLabel.htmlFor = "linkgen-fondo-select";
  fondoSelect.id = "linkgen-fondo-select";
  fondoSelect.addEventListener("change", () => {
    state.fondo = fondoSelect.value as SceneFondo;
    renderOutput();
  });
  fondoField.append(fondoFieldLabel, fondoSelect);

  const sceneRow = document.createElement("div");
  sceneRow.className = "linkgen-check-row";
  const loadAllCheck = makeCheckbox(
    "Pre-cargar todos los modelos (?load=all)",
    state.loadAll
  );
  loadAllCheck.input.addEventListener("change", () => {
    state.loadAll = loadAllCheck.input.checked;
    renderOutput();
  });
  sceneRow.appendChild(loadAllCheck.el);

  sceneSection.append(sceneLabel, fondoField, sceneRow);
  shell.appendChild(sceneSection);

  /** Performance / LOD */
  const perfSection = document.createElement("div");
  perfSection.className = "linkgen-section";
  const perfLabel = document.createElement("p");
  perfLabel.className = "linkgen-section-label";
  perfLabel.textContent = "Rendimiento";

  const lodField = document.createElement("div");
  lodField.className = "linkgen-field";
  const lodFieldLabel = document.createElement("label");
  lodFieldLabel.className = "linkgen-field-label";
  lodFieldLabel.textContent = "LOD";
  lodFieldLabel.htmlFor = "linkgen-lod-select";
  const lodSelect = document.createElement("select");
  lodSelect.className = "linkgen-select";
  lodSelect.id = "linkgen-lod-select";
  for (const opt of [
    { value: "", label: "Automático (según dispositivo)" },
    { value: "desktop", label: "Desktop (calidad máxima)" },
    { value: "mobile", label: "Mobile (rendimiento)" },
  ] as const) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    lodSelect.appendChild(option);
  }
  lodSelect.value = state.lod;
  lodSelect.addEventListener("change", () => {
    state.lod = lodSelect.value as LodOption;
    renderOutput();
  });
  lodField.append(lodFieldLabel, lodSelect);

  const maxSplatsField = document.createElement("div");
  maxSplatsField.className = "linkgen-field";
  const maxSplatsLabel = document.createElement("label");
  maxSplatsLabel.className = "linkgen-field-label";
  maxSplatsLabel.textContent = "Max Splats";
  maxSplatsLabel.htmlFor = "linkgen-maxsplats";
  const maxSplatsInput = document.createElement("input");
  maxSplatsInput.className = "linkgen-select";
  maxSplatsInput.id = "linkgen-maxsplats";
  maxSplatsInput.type = "number";
  maxSplatsInput.min = "10000";
  maxSplatsInput.step = "50000";
  maxSplatsInput.placeholder = "Auto";
  maxSplatsInput.value = state.maxSplats;
  maxSplatsInput.addEventListener("input", () => {
    state.maxSplats = maxSplatsInput.value;
    renderOutput();
  });
  maxSplatsField.append(maxSplatsLabel, maxSplatsInput);

  const maxShField = document.createElement("div");
  maxShField.className = "linkgen-field";
  const maxShLabel = document.createElement("label");
  maxShLabel.className = "linkgen-field-label";
  maxShLabel.textContent = "Max SH";
  maxShLabel.htmlFor = "linkgen-maxsh";
  const maxShSelect = document.createElement("select");
  maxShSelect.className = "linkgen-select";
  maxShSelect.id = "linkgen-maxsh";
  for (const opt of [
    { value: "", label: "Auto" },
    { value: "0", label: "0 (color plano)" },
    { value: "1", label: "1 (bajo)" },
    { value: "2", label: "2 (medio)" },
    { value: "3", label: "3 (completo)" },
  ] as const) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    maxShSelect.appendChild(option);
  }
  maxShSelect.value = state.maxSh;
  maxShSelect.addEventListener("change", () => {
    state.maxSh = maxShSelect.value;
    renderOutput();
  });
  maxShField.append(maxShLabel, maxShSelect);

  const perfCheckRow = document.createElement("div");
  perfCheckRow.className = "linkgen-check-row";
  const statsCheck = makeCheckbox("Mostrar Stats (?stats=1)", state.stats);
  statsCheck.input.addEventListener("change", () => {
    state.stats = statsCheck.input.checked;
    renderOutput();
  });
  perfCheckRow.appendChild(statsCheck.el);

  perfSection.append(perfLabel, lodField, maxSplatsField, maxShField, perfCheckRow);
  shell.appendChild(perfSection);

  /** Output */
  const outSection = document.createElement("div");
  outSection.className = "linkgen-section";
  const outLabel = document.createElement("p");
  outLabel.className = "linkgen-section-label";
  outLabel.textContent = "URL generado";
  const outWrap = document.createElement("div");
  outWrap.className = "linkgen-output";
  const outInput = document.createElement("input");
  outInput.className = "linkgen-output-input";
  outInput.type = "text";
  outInput.readOnly = true;
  outInput.spellcheck = false;
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "linkgen-copy-btn";
  copyBtn.textContent = "Copiar";
  let copyResetTimer: number | null = null;
  copyBtn.addEventListener("click", async () => {
    const url = outInput.value;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        /** Fallback for non-secure contexts (HTTP, older WebViews). */
        outInput.select();
        document.execCommand("copy");
      }
      copyBtn.textContent = "¡Copiado!";
      copyBtn.classList.add("copied");
      if (copyResetTimer) window.clearTimeout(copyResetTimer);
      copyResetTimer = window.setTimeout(() => {
        copyBtn.textContent = "Copiar";
        copyBtn.classList.remove("copied");
      }, 1500);
    } catch (err) {
      console.warn("[linkgen] clipboard write failed", err);
      copyBtn.textContent = "Error";
    }
  });
  outWrap.append(outInput, copyBtn);

  const previewLink = document.createElement("p");
  previewLink.className = "linkgen-preview-link";
  const previewAnchor = document.createElement("a");
  previewAnchor.target = "_blank";
  previewAnchor.rel = "noopener noreferrer";
  previewAnchor.textContent = "Abrir en una pestaña nueva ↗";
  previewLink.appendChild(previewAnchor);

  outSection.append(outLabel, outWrap, previewLink);
  shell.appendChild(outSection);

  root.replaceChildren(shell);

  /** ---------- Render helpers ---------- */

  function renderModels(): void {
    for (const btn of modelButtons) {
      btn.classList.toggle("selected", btn.dataset.modelId === state.modelId);
    }
  }

  function renderColors(): void {
    colorRow.innerHTML = "";
    const model = manifest.models.find((m) => m.id === state.modelId);
    if (!model) return;
    /**
     * Only render the five canonical colors that `?color=` accepts. Each is
     * disabled when the active model doesn't expose it, so the user can see
     * what's available without picking something that will silently fall
     * back to white at runtime.
     */
    for (const cid of ALLOWED_URL_COLORS) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className =
        "linkgen-color-dot" + (state.colorId === cid ? " selected" : "");
      dot.style.backgroundColor = resolveSwatchHex(state.modelId, cid);
      dot.title = cid;
      const available = modelHasColor(model, cid);
      dot.disabled = !available;
      dot.addEventListener("click", () => {
        if (!available) return;
        state.colorId = cid;
        renderColors();
        renderOutput();
      });
      colorRow.appendChild(dot);
    }
  }

  function renderViews(): void {
    for (const btn of viewButtons) {
      btn.classList.toggle("selected", btn.dataset.value === state.view);
    }
  }

  function renderOutput(): void {
    const url = buildUrl(state);
    outInput.value = url;
    previewAnchor.href = url;
  }

  renderModels();
  renderColors();
  renderViews();
  renderOutput();
}

async function main(): Promise<void> {
  const root = document.getElementById("linkgen-app");
  if (!root) return;
  try {
    const manifest = await fetchManifest();
    renderApp(root, manifest);
  } catch (err) {
    console.error("[linkgen] init failed", err);
    root.innerHTML = `<div class="linkgen-shell"><div class="linkgen-error">No se pudo cargar el manifest: ${(err as Error).message}</div></div>`;
  }
}

function makeCheckbox(label: string, checked: boolean): {
  el: HTMLLabelElement;
  input: HTMLInputElement;
} {
  const el = document.createElement("label");
  el.className = "linkgen-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  const span = document.createElement("span");
  span.textContent = label;
  el.append(input, span);
  return { el, input };
}

void main();
