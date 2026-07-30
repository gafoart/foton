/**
 * /ia — Editor de IA. Lets the client update the chatbot's training text
 * for Changan (brand-wide identity prompt) and for each vehicle without a
 * code deploy. Backed by the `/api/knowledge/<slug>` Pages Function, which
 * stores overrides in MANIFEST_KV and falls back to the static asset that
 * ships with the build.
 *
 * Auth model: GET is anonymous (so the editor hydrates without prompting);
 * POST/DELETE go through `verifyEditorSession` server-side, which checks
 * the HMAC-signed session cookie set by `/auth/login`. If the cookie is
 * missing/expired the API returns 401 and we redirect to the login page.
 */
import type { SceneManifest } from "@changan/shared";
import { validateManifestSafe } from "@changan/shared";
import { marked } from "marked";
import DOMPurify from "dompurify";
import "./style.css";

marked.use({ async: false, breaks: true, gfm: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName !== "A" || !(node instanceof Element)) return;
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
});

function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

/* ---------- Chat settings (nickname + avatar) ---------- */

interface ChatSettingsData {
  nickname: string;
}

async function fetchChatSettings(): Promise<ChatSettingsData> {
  const defaults: ChatSettingsData = { nickname: "PANDi" };
  try {
    const res = await fetch("/api/chat-settings", { cache: "no-store" });
    if (!res.ok) return defaults;
    const data = (await res.json()) as Partial<ChatSettingsData>;
    return {
      nickname: typeof data.nickname === "string" && data.nickname.trim() ? data.nickname.trim() : defaults.nickname,
    };
  } catch {
    return defaults;
  }
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data.error) return data.error;
  } catch { /* non-JSON response */ }
  return `Error ${res.status}`;
}

async function saveChatNickname(nickname: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch("/api/chat-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ nickname }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      redirectToLogin();
      return { ok: false, message: "Sesión expirada" };
    }
    return { ok: false, message: await parseErrorMessage(res) };
  } catch (err) {
    return { ok: false, message: `Error de red: ${(err as Error).message}` };
  }
}

async function uploadAvatar(file: File): Promise<{ ok: boolean; message?: string }> {
  try {
    const form = new FormData();
    form.append("avatar", file);
    const res = await fetch("/api/chat-avatar", {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      redirectToLogin();
      return { ok: false, message: "Sesión expirada" };
    }
    return { ok: false, message: await parseErrorMessage(res) };
  } catch (err) {
    return { ok: false, message: `Error de red: ${(err as Error).message}` };
  }
}

type PreviewPane = "edit" | "preview";

const DISPLAY_NAMES: Record<string, string> = {
  foton: "Foton (identidad general)",
  "3t": "Foton 3T",
};

type KnowledgeSource = "kv" | "asset";

interface KnowledgeDoc {
  slug: string;
  text: string;
  /** Last text returned by the server — used to compute the dirty flag. */
  serverText: string;
  source: KnowledgeSource;
  loaded: boolean;
  loading: boolean;
}

interface PageState {
  manifest: SceneManifest | null;
  docs: Map<string, KnowledgeDoc>;
  activeSlug: string;
}

const state: PageState = {
  manifest: null,
  docs: new Map(),
  activeSlug: "foton",
};

async function fetchManifest(): Promise<SceneManifest | null> {
  /**
   * Same fallback chain as the linkgen page; the manifest tells us the model
   * IDs (each becomes a knowledge slug).
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
    } catch {
      // try next
    }
  }
  return null;
}

interface AuthInfo {
  enabled: boolean;
  signedIn?: boolean;
  email?: string;
}

async function fetchAuthInfo(): Promise<AuthInfo | null> {
  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as AuthInfo;
  } catch {
    return null;
  }
}

async function hydrateAuthBadge(host: HTMLElement): Promise<void> {
  const info = await fetchAuthInfo();
  if (!info?.enabled || !info.signedIn || !info.email) return;
  host.style.display = "";
  host.innerHTML = "";
  const emailSpan = document.createElement("span");
  emailSpan.className = "ia-auth-email";
  emailSpan.textContent = info.email;
  emailSpan.title = info.email;
  const logout = document.createElement("a");
  logout.className = "ia-back ia-back--logout";
  logout.href = "/auth/logout?next=/ia";
  logout.textContent = "Cerrar sesión";
  host.append(emailSpan, logout);
}

function listSlugs(manifest: SceneManifest): string[] {
  /**
   * "foton" first (identidad general) then each model in manifest order.
   * Anything beyond what the chatbot actually requests is hidden.
   */
  return ["foton", ...manifest.models.map((m) => m.id)];
}

async function fetchKnowledge(slug: string): Promise<{
  text: string;
  source: KnowledgeSource;
} | null> {
  try {
    const res = await fetch(`/api/knowledge/${slug}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { text?: string; source?: KnowledgeSource };
    if (typeof data.text !== "string") return null;
    return { text: data.text, source: data.source === "kv" ? "kv" : "asset" };
  } catch {
    return null;
  }
}

interface SaveResult {
  ok: boolean;
  status: number;
  message?: string;
}

async function saveKnowledge(slug: string, text: string): Promise<SaveResult> {
  try {
    const res = await fetch(`/api/knowledge/${slug}`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      credentials: "include",
    });
    if (res.ok) return { ok: true, status: res.status };
    let message: string | undefined;
    try {
      const data = (await res.json()) as { error?: string };
      message = data.error;
    } catch {
      // ignore
    }
    return { ok: false, status: res.status, message };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: `Network error: ${(err as Error).message}`,
    };
  }
}

async function resetKnowledge(slug: string): Promise<
  | { ok: true; text: string; source: KnowledgeSource }
  | { ok: false; status: number; message?: string }
> {
  try {
    const res = await fetch(`/api/knowledge/${slug}`, {
      method: "DELETE",
      cache: "no-store",
      credentials: "include",
    });
    if (res.ok) {
      const data = (await res.json()) as { text?: string; source?: KnowledgeSource };
      return {
        ok: true,
        text: typeof data.text === "string" ? data.text : "",
        source: data.source === "kv" ? "kv" : "asset",
      };
    }
    let message: string | undefined;
    try {
      const data = (await res.json()) as { error?: string };
      message = data.error;
    } catch {
      // ignore
    }
    return { ok: false, status: res.status, message };
  } catch (err) {
    return { ok: false, status: 0, message: `Network error: ${(err as Error).message}` };
  }
}

/* ---------- UI ---------- */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function bytes(n: number): string {
  return `${n.toLocaleString()} car.`;
}

interface RenderHandles {
  slugList: HTMLUListElement;
  editorName: HTMLElement;
  editorMeta: HTMLElement;
  textarea: HTMLTextAreaElement;
  preview: HTMLElement;
  paneRoot: HTMLElement;
  editTab: HTMLButtonElement;
  previewTab: HTMLButtonElement;
  charCount: HTMLElement;
  saveBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  statusEl: HTMLElement;
}

/**
 * Auth failures from the API now mean the session cookie is missing or
 * expired — there's no token to prompt for. Bounce to /auth/login and come
 * back to /ia after sign-in.
 */
function redirectToLogin(): void {
  const next = encodeURIComponent("/ia");
  window.location.href = `/auth/login?next=${next}&error=${encodeURIComponent(
    "Tu sesión venció o no tienes permiso para editar. Vuelve a iniciar sesión."
  )}`;
}

function renderApp(root: HTMLElement, slugs: string[]): RenderHandles {
  root.innerHTML = "";
  const shell = el("div", "ia-shell");

  const header = el("div", "ia-header");
  const titleWrap = el("div");
  const title = el("h1", "ia-title");
  title.textContent = "Editor de IA";
  const subtitle = el("p", "ia-subtitle");
  subtitle.textContent =
    "Edita los archivos de entrenamiento de PANDi, el asistente virtual de Foton. Cada cambio se publica al guardar y empieza a usarse en la próxima conversación.";
  titleWrap.append(title, subtitle);
  const navWrap = el("div", "ia-nav");
  const showroomLink = el("a", "ia-back");
  showroomLink.href = "/";
  showroomLink.textContent = "← Showroom";
  const manualLink = el("a", "ia-back");
  manualLink.href = "/product";
  manualLink.textContent = "Manual";
  navWrap.append(showroomLink, manualLink);
  /** Auth chrome (signed-in email + logout). Fetched async and inserted when ready. */
  const authBadge = el("span", "ia-auth-badge");
  authBadge.style.display = "none";
  navWrap.appendChild(authBadge);
  void hydrateAuthBadge(authBadge);
  header.append(titleWrap, navWrap);
  shell.appendChild(header);

  /* --- Chat profile settings section --- */
  const profileSection = el("section", "ia-profile-section");
  const profileTitle = el("h2", "ia-profile-title");
  profileTitle.textContent = "Perfil del asistente";
  const profileDesc = el("p", "ia-profile-desc");
  profileDesc.textContent = "Foto de perfil y apodo del chatbot visible para los usuarios.";

  const profileContent = el("div", "ia-profile-content");

  /* Avatar circle with hover edit overlay */
  const avatarWrap = el("div", "ia-profile-avatar-wrap");
  const avatarPreviewImg = el("img", "ia-profile-avatar-preview");
  avatarPreviewImg.alt = "Foto actual";
  avatarPreviewImg.src = "/api/chat-avatar";
  const avatarOverlay = el("div", "ia-profile-avatar-overlay");
  avatarOverlay.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const avatarFileInput = el("input");
  avatarFileInput.type = "file";
  avatarFileInput.accept = "image/png,image/jpeg,image/webp,image/gif";
  avatarFileInput.className = "ia-profile-file-input";
  avatarWrap.append(avatarPreviewImg, avatarOverlay, avatarFileInput);
  const avatarStatus = el("span", "ia-status ia-profile-avatar-status");

  /* Nickname row: input + save button */
  const nicknameRow = el("div", "ia-profile-nickname-row");
  const nicknameInput = el("input", "ia-profile-input");
  nicknameInput.type = "text";
  nicknameInput.maxLength = 50;
  nicknameInput.placeholder = "PANDi";
  const nicknameSaveBtn = el("button", "ia-btn ia-btn-primary ia-btn-sm");
  nicknameSaveBtn.type = "button";
  nicknameSaveBtn.textContent = "Guardar";
  nicknameSaveBtn.disabled = true;
  const nicknameStatus = el("span", "ia-status");
  nicknameRow.append(nicknameInput, nicknameSaveBtn, nicknameStatus);

  profileContent.append(avatarWrap, avatarStatus, nicknameRow);
  profileSection.append(profileTitle, profileDesc, profileContent);
  shell.appendChild(profileSection);

  let profileLoaded = false;
  let savedNickname = "";

  function syncNicknameSaveBtn(): void {
    nicknameSaveBtn.disabled = !profileLoaded || nicknameInput.value.trim() === savedNickname;
  }

  nicknameInput.addEventListener("input", syncNicknameSaveBtn);

  nicknameSaveBtn.addEventListener("click", async () => {
    nicknameSaveBtn.disabled = true;
    nicknameStatus.textContent = "Guardando…";
    nicknameStatus.className = "ia-status";
    const result = await saveChatNickname(nicknameInput.value.trim() || "PANDi");
    if (result.ok) {
      savedNickname = nicknameInput.value.trim() || "PANDi";
      nicknameStatus.textContent = "Guardado.";
      nicknameStatus.className = "ia-status ok";
    } else {
      nicknameStatus.textContent = result.message ?? "Error";
      nicknameStatus.className = "ia-status err";
    }
    syncNicknameSaveBtn();
  });

  avatarWrap.addEventListener("click", () => avatarFileInput.click());
  avatarFileInput.addEventListener("change", async () => {
    const file = avatarFileInput.files?.[0] ?? null;
    if (!file) return;
    const localUrl = URL.createObjectURL(file);
    avatarPreviewImg.src = localUrl;
    avatarStatus.textContent = "Subiendo…";
    avatarStatus.className = "ia-status";
    const result = await uploadAvatar(file);
    if (result.ok) {
      avatarStatus.textContent = "Actualizada.";
      avatarStatus.className = "ia-status ok";
      avatarPreviewImg.src = `/api/chat-avatar?t=${Date.now()}`;
    } else {
      avatarStatus.textContent = result.message ?? "Error";
      avatarStatus.className = "ia-status err";
    }
    avatarFileInput.value = "";
  });

  void fetchChatSettings().then((settings) => {
    savedNickname = settings.nickname;
    nicknameInput.value = settings.nickname;
    profileLoaded = true;
    syncNicknameSaveBtn();
  });

  const layout = el("div", "ia-layout");

  /** Sidebar */
  const sidebar = el("aside", "ia-sidebar");
  const sideLabel = el("p", "ia-sidebar-label");
  sideLabel.textContent = "Archivos";
  const slugList = el("ul", "ia-slug-list");
  sidebar.append(sideLabel, slugList);
  layout.appendChild(sidebar);

  /** Editor */
  const editor = el("section", "ia-editor");
  const editorHeader = el("div", "ia-editor-header");
  const editorNameWrap = el("div");
  const editorName = el("h2", "ia-editor-name");
  const editorMeta = el("p", "ia-editor-meta");
  editorNameWrap.append(editorName, editorMeta);

  /** Pane toggle (mobile collapses to one pane at a time). */
  const tabRow = el("div", "ia-tabs");
  const editTab = el("button", "ia-tab active");
  editTab.type = "button";
  editTab.textContent = "Editar";
  editTab.dataset.pane = "edit";
  const previewTab = el("button", "ia-tab");
  previewTab.type = "button";
  previewTab.textContent = "Vista previa";
  previewTab.dataset.pane = "preview";
  tabRow.append(editTab, previewTab);

  editorHeader.append(editorNameWrap, tabRow);
  editor.appendChild(editorHeader);

  const paneRoot = el("div", "ia-panes");
  const textarea = el("textarea", "ia-textarea");
  textarea.spellcheck = false;
  textarea.autocomplete = "off";
  const preview = el("div", "ia-preview");
  paneRoot.append(textarea, preview);
  editor.appendChild(paneRoot);

  const stats = el("div", "ia-stats");
  const charCount = el("span");
  stats.appendChild(charCount);
  editor.appendChild(stats);

  const toolbar = el("div", "ia-toolbar");
  const saveBtn = el("button", "ia-btn ia-btn-primary");
  saveBtn.type = "button";
  saveBtn.textContent = "Guardar cambios";
  const resetBtn = el("button", "ia-btn ia-btn-ghost");
  resetBtn.type = "button";
  resetBtn.textContent = "Restablecer original";
  resetBtn.title = "Descarta el override y vuelve al texto que viene con el sitio.";
  const statusEl = el("span", "ia-status");
  toolbar.append(saveBtn, resetBtn, statusEl);
  editor.appendChild(toolbar);

  layout.appendChild(editor);
  shell.appendChild(layout);
  root.appendChild(shell);

  /** Sidebar items */
  for (const slug of slugs) {
    const li = el("li");
    const btn = el("button", "ia-slug-btn");
    btn.type = "button";
    btn.dataset.slug = slug;
    const labelSpan = el("span");
    labelSpan.textContent = DISPLAY_NAMES[slug] ?? slug;
    const pill = el("span", "ia-slug-pill muted");
    pill.textContent = "ASSET";
    btn.append(labelSpan, pill);
    btn.addEventListener("click", () => {
      void selectSlug(slug);
    });
    li.appendChild(btn);
    slugList.appendChild(li);
  }

  return {
    slugList,
    editorName,
    editorMeta,
    textarea,
    preview,
    paneRoot,
    editTab,
    previewTab,
    charCount,
    saveBtn,
    resetBtn,
    statusEl,
  };
}

let handles: RenderHandles;
let activePane: PreviewPane = "edit";
let previewRenderTimer: number | null = null;

function refreshPreview(immediate = false): void {
  const run = (): void => {
    const doc = state.docs.get(state.activeSlug);
    handles.preview.innerHTML = doc?.loaded ? renderMarkdown(doc.text) : "";
  };
  if (immediate) {
    if (previewRenderTimer !== null) {
      window.clearTimeout(previewRenderTimer);
      previewRenderTimer = null;
    }
    run();
    return;
  }
  if (previewRenderTimer !== null) window.clearTimeout(previewRenderTimer);
  previewRenderTimer = window.setTimeout(() => {
    previewRenderTimer = null;
    run();
  }, 150);
}

function setActivePane(pane: PreviewPane): void {
  activePane = pane;
  handles.paneRoot.dataset.active = pane;
  handles.editTab.classList.toggle("active", pane === "edit");
  handles.previewTab.classList.toggle("active", pane === "preview");
  if (pane === "preview") refreshPreview(true);
}

function updateSidebar(): void {
  const buttons = handles.slugList.querySelectorAll<HTMLButtonElement>(".ia-slug-btn");
  buttons.forEach((btn) => {
    const slug = btn.dataset.slug ?? "";
    btn.classList.toggle("active", slug === state.activeSlug);
    btn.disabled = !!state.docs.get(slug)?.loading;

    const pill = btn.querySelector<HTMLElement>(".ia-slug-pill");
    if (!pill) return;
    const doc = state.docs.get(slug);
    pill.className = "ia-slug-pill muted";
    if (!doc || !doc.loaded) {
      pill.textContent = "…";
      return;
    }
    if (doc.text !== doc.serverText) {
      pill.className = "ia-slug-pill dirty";
      pill.textContent = "MODIF.";
      return;
    }
    if (doc.source === "kv") {
      pill.className = "ia-slug-pill";
      pill.textContent = "KV";
      return;
    }
    pill.textContent = "ASSET";
  });
}

function setStatus(text: string, kind: "" | "ok" | "err" = ""): void {
  handles.statusEl.textContent = text;
  handles.statusEl.className = `ia-status${kind ? " " + kind : ""}`;
}

function renderActiveDoc(): void {
  const doc = state.docs.get(state.activeSlug);
  handles.editorName.textContent = DISPLAY_NAMES[state.activeSlug] ?? state.activeSlug;

  if (!doc || !doc.loaded) {
    handles.editorMeta.textContent = "Cargando…";
    handles.textarea.value = "";
    handles.textarea.disabled = true;
    handles.preview.innerHTML = "";
    handles.saveBtn.disabled = true;
    handles.resetBtn.disabled = true;
    handles.charCount.textContent = "";
    return;
  }

  handles.textarea.disabled = false;
  handles.textarea.value = doc.text;
  handles.charCount.innerHTML = `<strong>${bytes(doc.text.length)}</strong>`;
  refreshPreview(true);
  const dirty = doc.text !== doc.serverText;
  handles.saveBtn.disabled = !dirty;
  handles.resetBtn.disabled = doc.source !== "kv" && !dirty;
  handles.editorMeta.textContent =
    doc.source === "kv"
      ? "Tiene un override guardado (se sirve desde KV)."
      : "Sin override; se sirve el archivo original incluido en el sitio.";
  setStatus("");
}

function setDoc(slug: string, patch: Partial<KnowledgeDoc>): void {
  const prev = state.docs.get(slug);
  const next: KnowledgeDoc = {
    slug,
    text: prev?.text ?? "",
    serverText: prev?.serverText ?? "",
    source: prev?.source ?? "asset",
    loaded: prev?.loaded ?? false,
    loading: prev?.loading ?? false,
    ...patch,
  };
  state.docs.set(slug, next);
  if (slug === state.activeSlug) renderActiveDoc();
  updateSidebar();
}

async function loadDoc(slug: string): Promise<void> {
  const existing = state.docs.get(slug);
  if (existing?.loaded || existing?.loading) return;
  setDoc(slug, { loading: true });
  const data = await fetchKnowledge(slug);
  if (!data) {
    setDoc(slug, {
      loaded: false,
      loading: false,
      text: "",
      serverText: "",
    });
    if (slug === state.activeSlug) {
      setStatus("No se pudo cargar el archivo.", "err");
    }
    return;
  }
  setDoc(slug, {
    loading: false,
    loaded: true,
    text: data.text,
    serverText: data.text,
    source: data.source,
  });
}

async function selectSlug(slug: string): Promise<void> {
  state.activeSlug = slug;
  renderActiveDoc();
  updateSidebar();
  await loadDoc(slug);
}

async function handleSave(): Promise<void> {
  const doc = state.docs.get(state.activeSlug);
  if (!doc) return;
  handles.saveBtn.disabled = true;
  setStatus("Guardando…");
  const result = await saveKnowledge(doc.slug, doc.text);
  if (!result.ok && (result.status === 401 || result.status === 403)) {
    setStatus("Tu sesión venció. Redirigiendo…", "err");
    redirectToLogin();
    return;
  }
  if (!result.ok) {
    setStatus(`Error al guardar (${result.status}): ${result.message ?? "desconocido"}`, "err");
    handles.saveBtn.disabled = doc.text === doc.serverText;
    return;
  }
  setDoc(doc.slug, {
    serverText: doc.text,
    /** After a successful save, the doc lives in KV. */
    source: "kv",
  });
  setStatus("Guardado.", "ok");
}

async function handleReset(): Promise<void> {
  const doc = state.docs.get(state.activeSlug);
  if (!doc) return;
  if (
    !window.confirm(
      "Esto eliminará el override guardado y volverá al texto original. ¿Continuar?"
    )
  ) {
    return;
  }
  handles.resetBtn.disabled = true;
  setStatus("Restableciendo…");
  const result = await resetKnowledge(doc.slug);
  if (!result.ok && (result.status === 401 || result.status === 403)) {
    setStatus("Tu sesión venció. Redirigiendo…", "err");
    redirectToLogin();
    return;
  }
  if (!result.ok) {
    setStatus(`Error (${result.status}): ${result.message ?? "desconocido"}`, "err");
    renderActiveDoc();
    return;
  }
  setDoc(doc.slug, {
    text: result.text,
    serverText: result.text,
    source: "asset",
  });
  setStatus("Restablecido al original.", "ok");
}

async function main(): Promise<void> {
  const root = document.getElementById("ia-app");
  if (!root) return;

  const manifest = await fetchManifest();
  if (!manifest) {
    root.innerHTML = `<div class="ia-shell"><div class="ia-error-box">No se pudo cargar el manifest — el editor necesita conocer la lista de modelos.</div></div>`;
    return;
  }
  state.manifest = manifest;
  const slugs = listSlugs(manifest);

  handles = renderApp(root, slugs);
  setActivePane(activePane);
  handles.textarea.addEventListener("input", () => {
    const doc = state.docs.get(state.activeSlug);
    if (!doc) return;
    setDoc(doc.slug, { text: handles.textarea.value });
    refreshPreview();
  });
  handles.editTab.addEventListener("click", () => setActivePane("edit"));
  handles.previewTab.addEventListener("click", () => setActivePane("preview"));
  handles.saveBtn.addEventListener("click", () => {
    void handleSave();
  });
  handles.resetBtn.addEventListener("click", () => {
    void handleReset();
  });

  window.addEventListener("beforeunload", (e) => {
    const anyDirty = Array.from(state.docs.values()).some(
      (d) => d.loaded && d.text !== d.serverText
    );
    if (anyDirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  /** Boot: load every file in the background so the sidebar pills are accurate. */
  await selectSlug(state.activeSlug);
  for (const slug of slugs) {
    if (slug !== state.activeSlug) void loadDoc(slug);
  }
}

void main();
