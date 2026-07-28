import { isEmailAllowed, parseAllowedDomains, sanitizeNextPath, type OAuthEnv } from "../lib/oauth.js";
import { hashPassword } from "../lib/password.js";
import {
  createVerificationToken,
  getUser,
  normalizeEmail,
  putUser,
  type UsersEnv,
} from "../lib/users.js";
import { buildVerificationEmail, isEmailConfigured, sendEmail, type EmailEnv } from "../lib/email.js";
import { isSameOrigin } from "../lib/session.js";
import { ipKey, rateLimit } from "../lib/ratelimit.js";

type Env = OAuthEnv & UsersEnv & EmailEnv;

const REGISTER_RATE_LIMIT = 5;
const REGISTER_RATE_WINDOW_SECONDS = 60;

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shellStyles(): string {
  return `<style>
    @font-face { font-family: "Lato"; font-weight: 400; font-style: normal; font-display: swap; src: url("/fonts/lato-400.woff2") format("woff2"); }
    @font-face { font-family: "Lato"; font-weight: 700; font-style: normal; font-display: swap; src: url("/fonts/lato-700.woff2") format("woff2"); }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #0b0b0d; color: #ececef;
      font-family: "Lato", system-ui, sans-serif; min-height: 100vh; line-height: 1.55;
      -webkit-font-smoothing: antialiased; }
    .auth-shell { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    .auth-card { width: 100%; max-width: 420px; background: rgba(28,28,30,0.7); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 18px; padding: 2.1rem 1.85rem 2rem; }
    .auth-eyebrow { margin: 0 0 0.55rem; font-size: 0.7rem; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 700; color: rgba(255,255,255,0.5); }
    .auth-title { margin: 0 0 0.5rem; font-size: 1.45rem; font-weight: 700; }
    .auth-desc { margin: 0 0 1.5rem; font-size: 0.9rem; color: rgba(236,236,239,0.7); }
    form.auth-form { display: flex; flex-direction: column; gap: 0.85rem; }
    .auth-field { display: flex; flex-direction: column; gap: 0.35rem; }
    .auth-field label { font-size: 0.78rem; letter-spacing: 0.04em; color: rgba(236,236,239,0.7); font-weight: 600; }
    .auth-field input { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
      color: #ececef; border-radius: 10px; padding: 0.7rem 0.85rem; font-size: 0.95rem; font-family: inherit;
      outline: none; transition: border-color 0.15s ease, background 0.15s ease; }
    .auth-field input:focus { border-color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.09); }
    .auth-submit { background: #fff; color: #1a1a1c; padding: 0.85rem 1.05rem;
      border-radius: 12px; border: none; cursor: pointer; font-weight: 700; font-size: 0.95rem;
      transition: background 0.18s ease, transform 0.12s ease; }
    .auth-submit:hover { background: rgba(255,255,255,0.9); }
    .auth-submit:active { transform: scale(0.98); }
    .auth-link-row { margin-top: 1.1rem; font-size: 0.85rem; color: rgba(236,236,239,0.65); text-align: center; }
    .auth-link-row a { color: #fff; text-decoration: underline; }
    .auth-domains { margin-top: 1.25rem; font-size: 0.82rem; color: rgba(236,236,239,0.55); }
    .auth-domains code { background: rgba(255,255,255,0.07); padding: 0.1em 0.45em; border-radius: 4px;
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; }
    .auth-error { background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.3); color: #fca5a5;
      padding: 0.85rem 1rem; border-radius: 10px; font-size: 0.88rem; margin-bottom: 1.25rem; }
    .auth-success { background: rgba(74,222,128,0.08); border: 1px solid rgba(74,222,128,0.3); color: #86efac;
      padding: 0.85rem 1rem; border-radius: 10px; font-size: 0.88rem; margin-bottom: 1.25rem; }
    .auth-foot { margin-top: 1.5rem; font-size: 0.78rem; color: rgba(236,236,239,0.45); text-align: center; }
    .auth-foot a { color: rgba(236,236,239,0.7); }
  </style>`;
}

function renderRegisterPage(opts: {
  next: string;
  domains: string[];
  emailValue?: string;
  error?: string;
  success?: string;
}): string {
  const { next, domains, emailValue, error, success } = opts;
  const nextEnc = encodeURIComponent(next);
  const domainsHtml = domains
    .map((d) => `<code>@${htmlEscape(d)}</code>`)
    .join(", ");
  const errBlock = error ? `<div class="auth-error">${htmlEscape(error)}</div>` : "";
  const okBlock = success ? `<div class="auth-success">${htmlEscape(success)}</div>` : "";
  const emailAttr = emailValue ? ` value="${htmlEscape(emailValue)}"` : "";
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Crear cuenta — Showroom Changan</title>
  <link rel="preload" as="font" type="font/woff2" href="/fonts/lato-400.woff2" crossorigin />
  <link rel="preload" as="font" type="font/woff2" href="/fonts/lato-700.woff2" crossorigin />
  ${shellStyles()}
</head>
<body>
  <main class="auth-shell">
    <div class="auth-card">
      <p class="auth-eyebrow">Showroom Changan</p>
      <h1 class="auth-title">Crear cuenta</h1>
      <p class="auth-desc">Te enviaremos un enlace de verificación al correo para activar tu cuenta.</p>
      ${errBlock}
      ${okBlock}
      <form class="auth-form" method="post" action="/auth/register?next=${nextEnc}">
        <div class="auth-field">
          <label for="email">Correo</label>
          <input id="email" name="email" type="email" required autocomplete="email" inputmode="email" autocapitalize="none"${emailAttr} />
        </div>
        <div class="auth-field">
          <label for="password">Contraseña (mínimo 8 caracteres)</label>
          <input id="password" name="password" type="password" required autocomplete="new-password" minlength="8" />
        </div>
        <div class="auth-field">
          <label for="confirm">Confirmar contraseña</label>
          <input id="confirm" name="confirm" type="password" required autocomplete="new-password" minlength="8" />
        </div>
        <button type="submit" class="auth-submit">Crear cuenta</button>
      </form>
      <p class="auth-link-row">¿Ya tienes cuenta? <a href="/auth/login?next=${nextEnc}">Inicia sesión</a></p>
      <p class="auth-domains">Solo se permite registrarse con cuentas de los dominios: ${domainsHtml}.</p>
      <p class="auth-foot"><a href="/">Ir al showroom público →</a></p>
    </div>
  </main>
</body>
</html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const next = sanitizeNextPath(url.searchParams.get("next"));
  const body = renderRegisterPage({
    next,
    domains: parseAllowedDomains(context.env),
  });
  return htmlResponse(body);
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const next = sanitizeNextPath(url.searchParams.get("next"));

  if (!env.MANIFEST_KV) {
    return htmlResponse(
      renderRegisterPage({
        next,
        domains: parseAllowedDomains(env),
        error: "El servicio de cuentas aún no está disponible (KV no configurado).",
      }),
      503
    );
  }
  if (!isEmailConfigured(env)) {
    return htmlResponse(
      renderRegisterPage({
        next,
        domains: parseAllowedDomains(env),
        error: "El servicio de email aún no está configurado en el servidor.",
      }),
      503
    );
  }

  /**
   * Same-origin guard. Registration POST is a state-changing endpoint
   * (creates a pending user + sends email); accept only same-site forms.
   */
  if (!isSameOrigin(request)) {
    return htmlResponse(
      renderRegisterPage({
        next,
        domains: parseAllowedDomains(env),
        error: "Solicitud rechazada (origen distinto).",
      }),
      403
    );
  }

  /** Per-IP rate limit to prevent registration spam + email bombing. */
  const rl = await rateLimit(env.MANIFEST_KV, ipKey(request, "register"), REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_SECONDS);
  if (!rl.allowed) {
    const res = htmlResponse(
      renderRegisterPage({
        next,
        domains: parseAllowedDomains(env),
        error: "Demasiados intentos. Esperá un minuto antes de probar de nuevo.",
      }),
      429
    );
    res.headers.set("Retry-After", String(rl.resetSeconds));
    return res;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return htmlResponse(
      renderRegisterPage({
        next,
        domains: parseAllowedDomains(env),
        error: "Formulario inválido.",
      }),
      400
    );
  }

  const rawEmail = (form.get("email") ?? "").toString();
  const password = (form.get("password") ?? "").toString();
  const confirm = (form.get("confirm") ?? "").toString();
  const email = normalizeEmail(rawEmail);

  const renderErr = (msg: string, status = 400): Response =>
    htmlResponse(
      renderRegisterPage({
        next,
        domains: parseAllowedDomains(env),
        emailValue: rawEmail,
        error: msg,
      }),
      status
    );

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return renderErr("El correo no tiene un formato válido.");
  }
  if (!isEmailAllowed(email, env)) {
    const domains = parseAllowedDomains(env).map((d) => `@${d}`).join(" o ");
    return renderErr(`Solo se permiten correos ${domains}.`);
  }
  if (password.length < 8) {
    return renderErr("La contraseña debe tener al menos 8 caracteres.");
  }
  if (password.length > 256) {
    return renderErr("La contraseña es demasiado larga.");
  }
  if (password !== confirm) {
    return renderErr("Las contraseñas no coinciden.");
  }

  const existing = await getUser(env.MANIFEST_KV, email);
  if (existing && existing.status === "active") {
    return renderErr("Ya existe una cuenta activa con ese correo. Inicia sesión.", 409);
  }

  /**
   * For both new signups and pending re-registrations we (re)hash the
   * password, mint a fresh verification token, and email it. Replacing
   * the password on a pending account is intentional — if a user lost
   * their first verification email and types a different password the
   * second time, we accept the latter as the source of truth.
   */
  const passwordHash = await hashPassword(password);
  const now = Math.floor(Date.now() / 1000);
  await putUser(env.MANIFEST_KV, {
    email,
    passwordHash,
    status: "pending",
    createdAt: existing?.createdAt ?? now,
  });
  const token = await createVerificationToken(env.MANIFEST_KV, email);
  const { subject, html, text } = buildVerificationEmail({
    origin: url.origin,
    email,
    token,
  });
  const sent = await sendEmail(env, { to: email, subject, html, text });
  if (!sent) {
    return renderErr(
      "No pudimos enviar el correo de verificación. Intenta de nuevo en unos minutos.",
      502
    );
  }

  /**
   * Always show the same success message regardless of whether the email
   * was already pending — keeps account enumeration to a minimum (an
   * attacker can still infer existence via the "active" error above, but
   * that branch only triggers for fully-verified accounts).
   */
  return htmlResponse(
    renderRegisterPage({
      next,
      domains: parseAllowedDomains(env),
      success: `Listo. Te enviamos un correo a ${email}. Abre el enlace para activar tu cuenta (vence en 24 horas).`,
    })
  );
};
