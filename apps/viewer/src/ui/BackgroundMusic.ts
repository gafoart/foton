// Lightweight looped background music for the showroom (desktop + mobile).
// - One <audio> element, looped, low volume — no library, negligible workload.
// - Browsers block audible autoplay until a user gesture (especially on mobile),
//   so we try to play on load and otherwise arm a one-shot gesture listener as a
//   fallback — the first tap/click/key starts it.
// - A small mute toggle (top-right) lets visitors silence it.

const SRC = "/foton-theme.mp3";
const VOLUME = 0.35;

export function initBackgroundMusic(mount: HTMLElement): void {
  const audio = new Audio(SRC);
  audio.loop = true;
  audio.volume = VOLUME;
  audio.preload = "auto";

  let muted = false;

  const btn = document.createElement("button");
  btn.className = "showroom-music-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", "Silenciar música");
  const ICON_ON =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>';
  const ICON_OFF =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
  btn.innerHTML = ICON_ON;

  btn.addEventListener("click", () => {
    muted = !muted;
    audio.muted = muted;
    btn.innerHTML = muted ? ICON_OFF : ICON_ON;
    btn.setAttribute("aria-label", muted ? "Activar música" : "Silenciar música");
    // If unmuting before playback ever started, kick it off.
    if (!muted && audio.paused) void audio.play().catch(() => {});
  });
  mount.appendChild(btn);

  const start = () => void audio.play().catch(() => {});

  // Try immediately; if autoplay is blocked, start on the first user gesture.
  audio.play().catch(() => {
    const onGesture = () => {
      start();
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
    window.addEventListener("pointerdown", onGesture, { once: true });
    window.addEventListener("keydown", onGesture, { once: true });
  });
}
