export type LoadingOverlayVariant = "fullscreen" | "corner";

const R = 44;
const CIRC = 2 * Math.PI * R;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function createProgressRing(): {
  svg: SVGSVGElement;
  setFraction: (f: number) => void;
} {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "loading-ring-svg");

  const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  track.setAttribute("cx", "50");
  track.setAttribute("cy", "50");
  track.setAttribute("r", String(R));
  track.setAttribute("class", "loading-ring-track");

  const bar = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  bar.setAttribute("cx", "50");
  bar.setAttribute("cy", "50");
  bar.setAttribute("r", String(R));
  bar.setAttribute("class", "loading-ring-bar");
  bar.style.strokeDasharray = `${CIRC}`;
  bar.style.strokeDashoffset = `${CIRC}`;

  svg.appendChild(track);
  svg.appendChild(bar);

  return {
    svg,
    setFraction: (f: number) => {
      const t = Math.max(0, Math.min(1, f));
      bar.style.strokeDashoffset = `${CIRC * (1 - t)}`;
    },
  };
}

export interface LoadingOverlayControls {
  el: HTMLElement;
  show: () => void;
  hide: () => void;
  /** 0–100 for display; drives ring and label */
  setProgress: (pct: number) => void;
  /** Fullscreen black curtain behind the progress chrome (no-op for corner variant). */
  fadeCurtainToBlack: (ms?: number) => Promise<void>;
  fadeCurtainToClear: (ms?: number) => Promise<void>;
  /**
   * Startup: show overlay with opaque black (no fade-in) until the first model is ready.
   * Fullscreen only; corner variant is a no-op for the curtain.
   */
  prepareStartupBlackout: () => void;
  /** Fade the whole overlay (curtain + chrome), then `hide()`. Used after initial bootstrap. */
  fadeOutEntireAndHide: (ms?: number) => Promise<void>;
}

export function createLoadingOverlay(
  variant: LoadingOverlayVariant = "fullscreen"
): LoadingOverlayControls {
  const el = document.createElement("div");
  el.className =
    variant === "fullscreen" ? "loading-overlay" : "loading-overlay loading-overlay--corner";
  el.hidden = true;

  const curtain = document.createElement("div");
  curtain.className = "loading-overlay-curtain";

  const chrome = document.createElement("div");
  chrome.className = "loading-overlay-chrome";

  const wrap = document.createElement("div");
  wrap.className = "loading-ring-wrap";

  const { svg, setFraction } = createProgressRing();
  const pctEl = document.createElement("span");
  pctEl.className = "loading-ring-pct";
  pctEl.textContent = "0%";

  wrap.appendChild(svg);
  wrap.appendChild(pctEl);
  chrome.appendChild(wrap);

  const sub = document.createElement("span");
  sub.className = "loading-subtext";
  sub.textContent = "Cargando…";
  chrome.appendChild(sub);

  el.appendChild(curtain);
  el.appendChild(chrome);

  const curtainEnabled = variant === "fullscreen";

  let lastPct = 0;
  let curtainOpaque = false;

  const waitCurtainTransitionEnd = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (e?: TransitionEvent) => {
        if (e && e.propertyName && e.propertyName !== "opacity") return;
        curtain.removeEventListener("transitionend", onEnd);
        clearTimeout(tid);
        resolve();
      };
      const onEnd = (e: TransitionEvent) => done(e);
      curtain.addEventListener("transitionend", onEnd);
      const tid = window.setTimeout(() => done(), ms + 120);
    });

  const waitElTransitionEnd = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (e?: TransitionEvent) => {
        if (e && e.propertyName && e.propertyName !== "opacity") return;
        el.removeEventListener("transitionend", onElEnd);
        clearTimeout(tid);
        resolve();
      };
      const onElEnd = (e: TransitionEvent) => done(e);
      el.addEventListener("transitionend", onElEnd);
      const tid = window.setTimeout(() => done(), ms + 120);
    });

  const hideImpl = (): void => {
    el.hidden = true;
    el.style.transition = "";
    el.style.opacity = "";
    curtain.style.transition = "";
    curtain.style.opacity = "";
    curtainOpaque = false;
  };

  return {
    el,
    show: () => {
      el.hidden = false;
    },
    hide: hideImpl,
    setProgress: (pct: number) => {
      lastPct = Math.max(0, Math.min(100, pct));
      setFraction(lastPct / 100);
      pctEl.textContent = `${Math.round(lastPct)}%`;
    },
    fadeCurtainToBlack: async (ms = 220) => {
      if (!curtainEnabled || curtainOpaque) return;
      if (prefersReducedMotion()) {
        curtain.style.opacity = "1";
        curtainOpaque = true;
        return;
      }
      const dur = Math.max(0, ms);
      curtain.style.transition = `opacity ${dur}ms ease-in-out`;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      curtain.style.opacity = "1";
      await waitCurtainTransitionEnd(dur);
      curtainOpaque = true;
    },
    fadeCurtainToClear: async (ms = 280) => {
      if (!curtainEnabled || !curtainOpaque) return;
      if (prefersReducedMotion()) {
        curtain.style.transition = "";
        curtain.style.opacity = "";
        curtainOpaque = false;
        return;
      }
      const dur = Math.max(0, ms);
      curtain.style.transition = `opacity ${dur}ms ease-out`;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      curtain.style.opacity = "0";
      await waitCurtainTransitionEnd(dur);
      curtain.style.transition = "";
      curtain.style.opacity = "";
      curtainOpaque = false;
    },
    prepareStartupBlackout: () => {
      el.hidden = false;
      el.style.transition = "none";
      el.style.opacity = "1";
      if (curtainEnabled) {
        curtain.style.transition = "none";
        curtain.style.opacity = "1";
        curtainOpaque = true;
      }
      lastPct = 0;
      setFraction(0);
      pctEl.textContent = "0%";
    },
    fadeOutEntireAndHide: async (ms = 360) => {
      if (el.hidden) {
        hideImpl();
        return;
      }
      if (prefersReducedMotion()) {
        hideImpl();
        return;
      }
      const dur = Math.max(0, ms);
      el.style.transition = "none";
      el.style.opacity = "1";
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      el.style.transition = `opacity ${dur}ms ease-out`;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      el.style.opacity = "0";
      await waitElTransitionEnd(dur);
      hideImpl();
    },
  };
}
