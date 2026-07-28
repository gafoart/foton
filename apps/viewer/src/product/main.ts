/**
 * /product — static delivery page for the Changan Showroom project.
 * The content is pure HTML; this entry imports the stylesheet so Vite
 * processes it, and (when auth is configured) injects a "Sesión: x —
 * Cerrar" line into the footer using /api/me.
 */
import "./style.css";

interface AuthInfo {
  enabled: boolean;
  signedIn?: boolean;
  email?: string;
}

async function hydrateSessionLine(): Promise<void> {
  let info: AuthInfo | null = null;
  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    if (res.ok) info = (await res.json()) as AuthInfo;
  } catch {
    return;
  }
  if (!info?.enabled || !info.signedIn || !info.email) return;
  const footer = document.querySelector(".product-footer");
  if (!footer) return;
  const p = document.createElement("p");
  p.className = "product-session";
  p.innerHTML = `Sesión: <strong>${info.email.replace(/</g, "&lt;")}</strong> · <a href="/auth/logout?next=/product">Cerrar sesión</a>`;
  footer.insertBefore(p, footer.firstChild);
}

void hydrateSessionLine();
