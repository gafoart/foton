import { marked } from "marked";
import DOMPurify from "dompurify";

type ChatRole = "user" | "assistant";

marked.use({
  async: false,
  breaks: true,
  gfm: true,
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName !== "A" || !(node instanceof Element)) return;
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
});

function assistantMarkdownToSafeHtml(markdown: string): string {
  const raw = marked.parse(markdown) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
  });
}

interface ChatTurn {
  role: ChatRole;
  content: string;
}

export interface ChatbotPanelOptions {
  container: HTMLElement;
  getModelId: () => string;
  getModelDisplayName: () => string;
  /**
   * Móvil: `true` cuando el panel de chat está abierto (bajar carga del visor, p. ej. pixelRatio).
   */
  onMobileChatPixelReduced?: (reduced: boolean) => void;
}

interface ChatSettings {
  nickname: string;
  avatarUrl: string;
}

async function fetchChatSettings(): Promise<ChatSettings> {
  const defaults: ChatSettings = { nickname: "PANDi", avatarUrl: "/api/chat-avatar" };
  try {
    const res = await fetch("/api/chat-settings", { cache: "no-store" });
    if (!res.ok) return defaults;
    const data = (await res.json()) as Partial<ChatSettings>;
    return {
      nickname: typeof data.nickname === "string" && data.nickname.trim() ? data.nickname.trim() : defaults.nickname,
      avatarUrl: typeof data.avatarUrl === "string" && data.avatarUrl.trim() ? data.avatarUrl.trim() : defaults.avatarUrl,
    };
  } catch {
    return defaults;
  }
}

const MOBILE_CHAT_MQ = "(max-width: 600px)";

export interface ChatbotPanelHandle {
  updateContext: () => void;
  destroy: () => void;
}

export function createChatbotPanel(options: ChatbotPanelOptions): ChatbotPanelHandle {
  const { container, getModelId, getModelDisplayName, onMobileChatPixelReduced } = options;

  const mq =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(MOBILE_CHAT_MQ)
      : null;

  let mobileOpen = mq?.matches === true ? false : true;
  /**
   * Counts assistant messages that arrived while the mobile chat was closed.
   * Drives both the red-circle badge on the floating toggle and the iOS-style
   * notification banner. Reset to 0 the moment the panel is opened.
   */
  let unreadCount = 0;

  const root = document.createElement("aside");
  root.className = "chatbot-panel";
  root.setAttribute("aria-label", "PANDi");

  const backdrop = document.createElement("div");
  backdrop.className = "chatbot-mobile-backdrop";
  backdrop.setAttribute("aria-hidden", "true");

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "chatbot-mobile-toggle";
  toggleBtn.setAttribute("aria-label", "Abrir chat con PANDi");

  const toggleIcon = document.createElement("img");
  toggleIcon.className = "chatbot-mobile-toggle-icon ui-icon-white";
  toggleIcon.src = "/ui-images/chat.svg";
  toggleIcon.alt = "";

  const toggleBadge = document.createElement("span");
  toggleBadge.className = "chatbot-mobile-toggle-badge";
  toggleBadge.textContent = "";
  toggleBadge.setAttribute("aria-hidden", "true");

  toggleBtn.appendChild(toggleIcon);
  toggleBtn.appendChild(toggleBadge);

  const header = document.createElement("div");
  header.className = "chatbot-header";

  const headerTop = document.createElement("div");
  headerTop.className = "chatbot-header-top";

  const identity = document.createElement("div");
  identity.className = "chatbot-identity";

  const avatar = document.createElement("img");
  avatar.className = "chatbot-avatar";
  avatar.src = "/ui-images/profile.png";
  avatar.alt = "";

  const titles = document.createElement("div");
  titles.className = "chatbot-titles";

  const title = document.createElement("h2");
  title.className = "chatbot-title";
  title.textContent = "PANDi";

  let botNickname = "PANDi";

  const contextLabel = document.createElement("p");
  contextLabel.className = "chatbot-context";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "chatbot-close";
  closeBtn.setAttribute("aria-label", "Cerrar chat");
  const closeIcon = document.createElement("img");
  closeIcon.className = "chatbot-close-icon ui-icon-white";
  closeIcon.src = "/ui-images/close.svg";
  closeIcon.alt = "";
  closeBtn.appendChild(closeIcon);

  titles.appendChild(title);
  titles.appendChild(contextLabel);

  identity.appendChild(avatar);
  identity.appendChild(titles);

  headerTop.appendChild(identity);
  headerTop.appendChild(closeBtn);
  header.appendChild(headerTop);

  const messagesEl = document.createElement("div");
  messagesEl.className = "chatbot-messages";
  messagesEl.setAttribute("role", "log");
  messagesEl.setAttribute("aria-live", "polite");

  const composer = document.createElement("div");
  composer.className = "chatbot-composer";

  const input = document.createElement("textarea");
  input.className = "chatbot-input";
  input.rows = 2;
  input.placeholder = "Escribe un mensaje…";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Mensaje");

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "chatbot-send";
  sendBtn.setAttribute("aria-label", "Enviar mensaje");
  const sendIcon = document.createElement("img");
  sendIcon.className = "chatbot-send-icon ui-icon-white";
  sendIcon.src = "/ui-images/send.svg";
  sendIcon.alt = "";
  sendBtn.appendChild(sendIcon);

  composer.appendChild(input);
  composer.appendChild(sendBtn);

  const notification = document.createElement("div");
  notification.className = "chatbot-notification";
  notification.setAttribute("role", "button");
  notification.setAttribute("aria-live", "polite");
  notification.setAttribute("aria-hidden", "true");
  notification.setAttribute("aria-label", `Abrir chat con ${botNickname}`);
  notification.tabIndex = -1;

  const notificationAvatar = document.createElement("img");
  notificationAvatar.className = "chatbot-notification-avatar";
  notificationAvatar.src = "/ui-images/profile.png";
  notificationAvatar.alt = "";

  const notificationBody = document.createElement("div");
  notificationBody.className = "chatbot-notification-body";

  const notificationName = document.createElement("div");
  notificationName.className = "chatbot-notification-name";
  notificationName.textContent = "PANDi";

  const notificationMessage = document.createElement("div");
  notificationMessage.className = "chatbot-notification-message";

  notificationBody.appendChild(notificationName);
  notificationBody.appendChild(notificationMessage);
  notification.appendChild(notificationAvatar);
  notification.appendChild(notificationBody);

  root.appendChild(header);
  root.appendChild(messagesEl);
  root.appendChild(composer);

  const history: ChatTurn[] = [];
  let busy = false;
  let lastAnnouncedModelId = "";

  function greetingForModel(displayName: string): string {
    return `¡Hola! Soy PANDi, tu asistente en el showroom. Pregúntame lo que quieras sobre el ${displayName} que estás viendo.`;
  }

  function modelSwitchMessage(displayName: string): string {
    return `Has cambiado de modelo. A partir de ahora las respuestas serán sobre el ${displayName}. ¿En qué puedo ayudarte?`;
  }

  function scrollToBottom(): void {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderMessages(): void {
    messagesEl.innerHTML = "";
    for (const m of history) {
      const row = document.createElement("div");
      row.className = "chatbot-msg-row " + (m.role === "user" ? "chatbot-msg-user" : "chatbot-msg-assistant");
      const bubble = document.createElement("div");
      bubble.className =
        "chatbot-bubble" + (m.role === "assistant" ? " chatbot-md-content" : "");
      if (m.role === "assistant") {
        bubble.innerHTML = assistantMarkdownToSafeHtml(m.content);
      } else {
        bubble.textContent = m.content;
      }
      row.appendChild(bubble);
      messagesEl.appendChild(row);
    }
    scrollToBottom();
  }

  function setBusy(v: boolean): void {
    busy = v;
    input.disabled = v;
    sendBtn.disabled = v;
  }

  function syncUnreadBadge(): void {
    const show = unreadCount > 0 && isMobileLayout();
    toggleBtn.classList.toggle("chatbot-mobile-toggle--unread", show);
    toggleBadge.textContent = show
      ? unreadCount > 99
        ? "99+"
        : String(unreadCount)
      : "";
    const label = show
      ? `Abrir chat — ${unreadCount} mensaje${unreadCount === 1 ? "" : "s"} nuevo${unreadCount === 1 ? "" : "s"} de ${botNickname}`
      : `Abrir chat con ${botNickname}`;
    toggleBtn.setAttribute("aria-label", label);
  }

  /**
   * Single entry point for any assistant message: appends to history,
   * re-renders, and — if mobile chat is closed — bumps the unread counter
   * AND surfaces the iOS-style notification banner so the user notices the
   * message even with the panel collapsed.
   */
  function pushAssistant(content: string): void {
    history.push({ role: "assistant", content });
    renderMessages();
    if (isMobileLayout() && !mobileOpen) {
      unreadCount++;
      showNotification(content);
      syncUnreadBadge();
    }
  }

  let notificationHideTimer: ReturnType<typeof setTimeout> | null = null;

  function hideNotificationNow(): void {
    if (notificationHideTimer !== null) {
      clearTimeout(notificationHideTimer);
      notificationHideTimer = null;
    }
    notification.classList.remove("chatbot-notification--visible");
    notification.setAttribute("aria-hidden", "true");
    notification.tabIndex = -1;
  }

  function showNotification(message: string): void {
    if (!isMobileLayout()) return;
    notificationMessage.textContent = message;
    notification.setAttribute("aria-hidden", "false");
    notification.tabIndex = 0;
    notification.classList.remove("chatbot-notification--visible");
    // Forzar reflow para reiniciar la transición si la notificación ya estaba visible.
    void notification.offsetWidth;
    notification.classList.add("chatbot-notification--visible");
    if (notificationHideTimer !== null) {
      clearTimeout(notificationHideTimer);
    }
    notificationHideTimer = window.setTimeout(() => {
      hideNotificationNow();
    }, 2000);
  }

  function updateContext(): void {
    const id = getModelId();
    const displayName = getModelDisplayName();
    contextLabel.textContent = `Preguntando por ${displayName}`;

    if (id !== lastAnnouncedModelId) {
      lastAnnouncedModelId = id;
      pushAssistant(modelSwitchMessage(displayName));
    }
    syncUnreadBadge();
  }

  // Per-visitor session id → conversation continuity in the Nodo backend.
  // Harmless for the OpenAI backend (field ignored there).
  function getChatSessionId(): string {
    const KEY = "chat-session-id";
    try {
      let id = localStorage.getItem(KEY);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(KEY, id);
      }
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }

  async function send(): Promise<void> {
    const text = input.value.trim();
    if (!text || busy) return;

    input.value = "";
    history.push({ role: "user", content: text });
    renderMessages();
    setBusy(true);

    const apiMessages = history.map((h) => ({ role: h.role, content: h.content }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: getModelId(),
          messages: apiMessages,
          sessionId: getChatSessionId(),
        }),
      });
      const data = (await res.json()) as { reply?: string; error?: string };

      if (!res.ok) {
        pushAssistant(data.error ?? `Algo salió mal (${res.status}).`);
      } else if (data.reply) {
        pushAssistant(data.reply);
      } else {
        pushAssistant(data.error ?? "Sin respuesta.");
      }
    } catch {
      pushAssistant(
        "No se pudo conectar con el asistente. En desarrollo con Vite, define OPENAI_API_KEY en apps/viewer/.env.local o en la raíz del repo y reinicia el servidor. Con Cloudflare usa `pnpm pages:dev` y .dev.vars."
      );
    } finally {
      setBusy(false);
      if (!isMobileLayout() || mobileOpen) {
        input.focus();
      }
    }
  }

  sendBtn.addEventListener("click", () => void send());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  function isMobileLayout(): boolean {
    return mq?.matches === true;
  }

  let visualViewportListenersAttached = false;

  function clearPanelViewportGeometry(): void {
    root.style.removeProperty("top");
    root.style.removeProperty("height");
    root.style.removeProperty("bottom");
    backdrop.style.removeProperty("top");
    backdrop.style.removeProperty("height");
    backdrop.style.removeProperty("bottom");
    backdrop.style.removeProperty("left");
    backdrop.style.removeProperty("width");
    backdrop.style.removeProperty("right");
  }

  /**
   * Móvil + panel abierto: alinear con el visual viewport (teclado) para no perder cabecera/mensajes.
   * Aplicado desde el primer frame del slide: la transición CSS es solo `transform`, así que los cambios
   * de `top`/`height` son instantáneos y trackean el teclado fotograma a fotograma. Si en lugar de esto
   * dejamos el panel a alto completo durante el slide y aplicamos la geometría al `transitionend`, iOS
   * comprime el panel en seco al final y se ve como un rebote.
   */
  function syncPanelToVisualViewport(): void {
    const vv = window.visualViewport;
    if (!vv || !isMobileLayout() || !mobileOpen) {
      clearPanelViewportGeometry();
      return;
    }
    root.style.top = `${vv.offsetTop}px`;
    root.style.height = `${vv.height}px`;
    root.style.bottom = "auto";
    backdrop.style.top = `${vv.offsetTop}px`;
    backdrop.style.height = `${vv.height}px`;
    backdrop.style.bottom = "auto";
    backdrop.style.left = `${vv.offsetLeft}px`;
    backdrop.style.width = `${vv.width}px`;
    backdrop.style.right = "auto";
  }

  function onVisualViewportChange(): void {
    syncPanelToVisualViewport();
  }

  function updateVisualViewportBinding(): void {
    const vv = window.visualViewport;
    if (isMobileLayout() && mobileOpen && vv) {
      if (!visualViewportListenersAttached) {
        vv.addEventListener("resize", onVisualViewportChange);
        vv.addEventListener("scroll", onVisualViewportChange);
        visualViewportListenersAttached = true;
      }
      syncPanelToVisualViewport();
    } else {
      if (vv && visualViewportListenersAttached) {
        vv.removeEventListener("resize", onVisualViewportChange);
        vv.removeEventListener("scroll", onVisualViewportChange);
        visualViewportListenersAttached = false;
      }
      syncPanelToVisualViewport();
    }
  }

  function syncLayout(): void {
    const mobile = isMobileLayout();
    if (!mobile) {
      mobileOpen = true;
    }
    root.classList.toggle("chatbot-panel--open", mobile && mobileOpen);
    root.setAttribute("aria-hidden", mobile && !mobileOpen ? "true" : "false");
    backdrop.classList.toggle("chatbot-mobile-backdrop--visible", mobile && mobileOpen);
    backdrop.setAttribute("aria-hidden", mobile && mobileOpen ? "false" : "true");
    toggleBtn.classList.toggle("chatbot-mobile-toggle--hidden", !mobile || mobileOpen);
    toggleBtn.setAttribute("tabindex", !mobile || mobileOpen ? "-1" : "0");
    syncUnreadBadge();
    onMobileChatPixelReduced?.(mobile && mobileOpen);
    updateVisualViewportBinding();
  }

  function setMobileOpen(open: boolean): void {
    if (!isMobileLayout()) return;
    if (open) {
      unreadCount = 0;
      hideNotificationNow();
    }
    mobileOpen = open;
    syncLayout();
    if (open) {
      // preventScroll evita que iOS Safari, al enfocar el textarea mientras el panel
      // todavía está parcialmente fuera de pantalla por la derecha (translateX>0), haga
      // scroll horizontal automático del documento — eso aparecía como un overshoot del
      // panel hacia la izquierda con hueco negro a la derecha y rebote al cerrar el slide.
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
    }
  }

  closeBtn.addEventListener("click", () => setMobileOpen(false));
  toggleBtn.addEventListener("click", () => setMobileOpen(true));
  backdrop.addEventListener("click", () => setMobileOpen(false));

  // Tap on the iOS-style notification opens the chat (and dismisses the toast).
  notification.addEventListener("click", () => {
    hideNotificationNow();
    setMobileOpen(true);
  });
  notification.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    hideNotificationNow();
    setMobileOpen(true);
  });

  const onMq = (): void => {
    if (!mq?.matches) {
      mobileOpen = true;
    }
    syncLayout();
  };
  mq?.addEventListener("change", onMq);

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !isMobileLayout() || !mobileOpen) return;
    e.preventDefault();
    setMobileOpen(false);
  };
  document.addEventListener("keydown", onKeydown);

  container.appendChild(backdrop);
  container.appendChild(toggleBtn);
  container.appendChild(root);
  container.appendChild(notification);
  syncLayout();

  /**
   * Initial greeting flows through pushAssistant so it counts as an unread
   * notification on mobile when the panel boots closed (which is the default
   * on mobile). updateContext() right after records the current model so the
   * very first call doesn't fire a redundant model-switch message.
   */
  lastAnnouncedModelId = getModelId();
  pushAssistant(greetingForModel(getModelDisplayName()));
  updateContext();

  void fetchChatSettings().then((settings) => {
    botNickname = settings.nickname;
    avatar.src = settings.avatarUrl;
    notificationAvatar.src = settings.avatarUrl;
    title.textContent = settings.nickname;
    notificationName.textContent = settings.nickname;
    root.setAttribute("aria-label", settings.nickname);
  });

  return {
    updateContext,
    destroy: () => {
      const vv = window.visualViewport;
      if (vv && visualViewportListenersAttached) {
        vv.removeEventListener("resize", onVisualViewportChange);
        vv.removeEventListener("scroll", onVisualViewportChange);
        visualViewportListenersAttached = false;
      }
      clearPanelViewportGeometry();
      mq?.removeEventListener("change", onMq);
      document.removeEventListener("keydown", onKeydown);
      if (notificationHideTimer !== null) {
        clearTimeout(notificationHideTimer);
        notificationHideTimer = null;
      }
      onMobileChatPixelReduced?.(false);
      backdrop.remove();
      toggleBtn.remove();
      root.remove();
      notification.remove();
    },
  };
}
