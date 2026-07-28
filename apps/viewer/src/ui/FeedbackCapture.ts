/**
 * Feedback capture: gated by `?test=1`. Top-left round buttons for photo /
 * video. After capture the user fills a form (Descripción, Vehículo, Color,
 * Dispositivo) and submits — the Pages Function `/api/feedback` then uploads
 * the media to R2 and creates a row in the Notion DB.
 *
 * The viewer's WebGL canvas runs with `preserveDrawingBuffer: false`, so the
 * photo path forces a fresh render and reads `toBlob()` synchronously in the
 * same microtask. Video uses `canvas.captureStream()` + `MediaRecorder`,
 * unaffected by the preserveDrawingBuffer setting.
 */

const VEHICLE_OPTIONS = ["Alsvin", "CS35", "CS55", "CS95", "Hunter", "Hunter Plus"] as const;
const COLOR_OPTIONS = ["Blanco", "Rojo", "Gris", "Plata", "Negro"] as const;
const DEVICE_OPTIONS = ["Mac", "Windows", "Android", "iPhone"] as const;

type Vehicle = typeof VEHICLE_OPTIONS[number];
type Color = typeof COLOR_OPTIONS[number];
type Device = typeof DEVICE_OPTIONS[number];

const MODEL_TO_VEHICLE: Record<string, Vehicle> = {
  alsvin: "Alsvin",
  cs35: "CS35",
  cs55: "CS55",
  cs95: "CS95",
  "hunter-d": "Hunter",
  "hunter-g": "Hunter Plus",
};

const COLOR_TO_NOTION: Record<string, Color> = {
  blanco: "Blanco",
  white: "Blanco",
  whitepearl: "Blanco",
  red: "Rojo",
  rojo: "Rojo",
  grey: "Gris",
  gray: "Gris",
  gris: "Gris",
  silver: "Plata",
  plata: "Plata",
  black: "Negro",
  negro: "Negro",
};

function detectDevice(): Device {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  return "Mac";
}

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

export interface FeedbackCaptureOptions {
  canvas: HTMLCanvasElement;
  /** Force one render so the canvas drawing buffer has fresh pixels (preserveDrawingBuffer is false). */
  triggerRender: () => void;
  /** Current model id from the manifest (e.g. "alsvin"). Used for vehicle prefill. */
  getCurrentModelId: () => string;
  /** Current color id from the manifest (e.g. "blanco"). Used for color prefill. */
  getCurrentColorId: () => string;
}

export interface FeedbackCaptureHandle {
  destroy: () => void;
}

export function createFeedbackCapture(opts: FeedbackCaptureOptions): FeedbackCaptureHandle {
  const { canvas, triggerRender, getCurrentModelId, getCurrentColorId } = opts;

  const root = document.createElement("div");
  root.className = "feedback-capture";

  const photoBtn = document.createElement("button");
  photoBtn.type = "button";
  photoBtn.className = "feedback-btn feedback-btn--photo";
  photoBtn.setAttribute("aria-label", "Capturar imagen");
  photoBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 8h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"/>
      <circle cx="12" cy="13" r="3.5"/>
    </svg>
  `;

  const videoBtn = document.createElement("button");
  videoBtn.type = "button";
  videoBtn.className = "feedback-btn feedback-btn--video";
  videoBtn.setAttribute("aria-label", "Grabar video");
  videoBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="13" height="12" rx="2"/>
      <path d="M16 10l5-3v10l-5-3z"/>
    </svg>
  `;

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "feedback-btn feedback-btn--stop";
  stopBtn.setAttribute("aria-label", "Detener grabación");
  stopBtn.hidden = true;
  stopBtn.innerHTML = `
    <span class="feedback-stop-square" aria-hidden="true"></span>
    <span class="feedback-stop-pulse" aria-hidden="true"></span>
  `;

  root.appendChild(photoBtn);
  root.appendChild(videoBtn);
  root.appendChild(stopBtn);
  document.body.appendChild(root);

  // ---------- Capture helpers ----------

  function captureImageBlob(): Promise<Blob | null> {
    return new Promise((resolve) => {
      // Render → toBlob in the same microtask so the buffer hasn't been cleared.
      try {
        triggerRender();
      } catch {
        /* render is best-effort */
      }
      canvas.toBlob((blob) => resolve(blob), "image/png", 0.92);
    });
  }

  let mediaRecorder: MediaRecorder | null = null;
  let mediaChunks: BlobPart[] = [];
  let recorderMime = "video/webm";

  function startRecording(): boolean {
    const mime = pickRecorderMime();
    if (!mime || typeof canvas.captureStream !== "function") {
      window.alert("Tu navegador no soporta grabación de canvas.");
      return false;
    }
    recorderMime = mime;
    mediaChunks = [];
    const stream = canvas.captureStream(30);
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) mediaChunks.push(e.data);
    };
    mediaRecorder.start(250);
    return true;
  }

  function stopRecording(): Promise<Blob | null> {
    return new Promise((resolve) => {
      if (!mediaRecorder) {
        resolve(null);
        return;
      }
      mediaRecorder.onstop = () => {
        const blob = new Blob(mediaChunks, { type: recorderMime });
        mediaChunks = [];
        mediaRecorder = null;
        resolve(blob);
      };
      try {
        mediaRecorder.stop();
      } catch {
        resolve(null);
      }
    });
  }

  // ---------- UI state ----------

  function setRecordingUI(recording: boolean): void {
    photoBtn.hidden = recording;
    videoBtn.hidden = recording;
    stopBtn.hidden = !recording;
    root.classList.toggle("feedback-capture--recording", recording);
  }

  // ---------- Form modal ----------

  interface CaptureMedia {
    blob: Blob;
    kind: "image" | "video";
    mime: string;
    extension: string;
  }

  function openForm(media: CaptureMedia): void {
    const overlay = document.createElement("div");
    overlay.className = "feedback-form-overlay";

    const card = document.createElement("div");
    card.className = "feedback-form-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "feedback-form-title");

    const title = document.createElement("h2");
    title.id = "feedback-form-title";
    title.className = "feedback-form-title";
    title.textContent = "Reportar feedback";

    const previewWrap = document.createElement("div");
    previewWrap.className = "feedback-form-preview";

    const previewUrl = URL.createObjectURL(media.blob);
    if (media.kind === "image") {
      const img = document.createElement("img");
      img.src = previewUrl;
      img.alt = "";
      previewWrap.appendChild(img);
    } else {
      const video = document.createElement("video");
      video.src = previewUrl;
      video.controls = true;
      video.muted = true;
      video.playsInline = true;
      previewWrap.appendChild(video);
    }

    const form = document.createElement("form");
    form.className = "feedback-form";
    form.noValidate = true;

    const descLabel = document.createElement("label");
    descLabel.className = "feedback-field";
    descLabel.innerHTML = `<span class="feedback-field-label">Descripción</span>`;
    const desc = document.createElement("textarea");
    desc.name = "descripcion";
    desc.required = true;
    desc.rows = 4;
    desc.placeholder = "Describe lo que ves...";
    descLabel.appendChild(desc);

    const vehicleLabel = makeSelect("Vehículo", "vehiculo", VEHICLE_OPTIONS);
    const colorLabel = makeSelect("Color", "color", COLOR_OPTIONS);
    const deviceLabel = makeSelect("Dispositivo", "dispositivo", DEVICE_OPTIONS);

    // Prefill from current scene state.
    const modelId = (getCurrentModelId() || "").toLowerCase();
    const colorId = (getCurrentColorId() || "").toLowerCase();
    const vehicleSel = vehicleLabel.querySelector("select") as HTMLSelectElement;
    const colorSel = colorLabel.querySelector("select") as HTMLSelectElement;
    const deviceSel = deviceLabel.querySelector("select") as HTMLSelectElement;
    const prefillVehicle = MODEL_TO_VEHICLE[modelId];
    if (prefillVehicle) vehicleSel.value = prefillVehicle;
    const prefillColor = COLOR_TO_NOTION[colorId];
    if (prefillColor) colorSel.value = prefillColor;
    deviceSel.value = detectDevice();

    const actions = document.createElement("div");
    actions.className = "feedback-form-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "feedback-form-cancel";
    cancelBtn.textContent = "Cancelar";

    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "feedback-form-submit";
    submitBtn.textContent = "Enviar";

    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);

    const status = document.createElement("div");
    status.className = "feedback-form-status";
    status.setAttribute("aria-live", "polite");

    form.appendChild(descLabel);
    form.appendChild(vehicleLabel);
    form.appendChild(colorLabel);
    form.appendChild(deviceLabel);
    form.appendChild(actions);
    form.appendChild(status);

    card.appendChild(title);
    card.appendChild(previewWrap);
    card.appendChild(form);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Focus the first interactive control for keyboard users.
    setTimeout(() => desc.focus(), 50);

    function close(): void {
      URL.revokeObjectURL(previewUrl);
      overlay.remove();
    }

    cancelBtn.addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (submitBtn.disabled) return;

      if (!desc.value.trim()) {
        status.textContent = "Escribe una descripción.";
        desc.focus();
        return;
      }

      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      status.textContent = "Enviando…";

      const fd = new FormData();
      fd.set("descripcion", desc.value.trim());
      fd.set("vehiculo", vehicleSel.value);
      fd.set("color", colorSel.value);
      fd.set("dispositivo", deviceSel.value);
      fd.set("media_kind", media.kind);
      fd.set("media", media.blob, `feedback-${Date.now()}.${media.extension}`);

      try {
        const res = await fetch("/api/feedback", { method: "POST", body: fd });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
        }
        status.textContent = "¡Gracias! Tu feedback fue enviado.";
        setTimeout(close, 1200);
      } catch (err) {
        status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    });
  }

  function makeSelect(label: string, name: string, options: readonly string[]): HTMLLabelElement {
    const wrap = document.createElement("label");
    wrap.className = "feedback-field";
    const labelSpan = document.createElement("span");
    labelSpan.className = "feedback-field-label";
    labelSpan.textContent = label;
    const sel = document.createElement("select");
    sel.name = name;
    sel.required = true;
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    }
    wrap.appendChild(labelSpan);
    wrap.appendChild(sel);
    return wrap;
  }

  // ---------- Wiring ----------

  photoBtn.addEventListener("click", async () => {
    photoBtn.disabled = true;
    try {
      const blob = await captureImageBlob();
      if (!blob) {
        window.alert("No se pudo capturar la imagen.");
        return;
      }
      openForm({ blob, kind: "image", mime: "image/png", extension: "png" });
    } finally {
      photoBtn.disabled = false;
    }
  });

  videoBtn.addEventListener("click", () => {
    if (!startRecording()) return;
    setRecordingUI(true);
  });

  stopBtn.addEventListener("click", async () => {
    setRecordingUI(false);
    const blob = await stopRecording();
    if (!blob || blob.size === 0) {
      window.alert("La grabación quedó vacía.");
      return;
    }
    const ext = recorderMime.includes("mp4") ? "mp4" : "webm";
    openForm({ blob, kind: "video", mime: recorderMime, extension: ext });
  });

  return {
    destroy(): void {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        try {
          mediaRecorder.stop();
        } catch {
          /* ignore */
        }
      }
      root.remove();
    },
  };
}
