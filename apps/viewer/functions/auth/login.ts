import {
  isGoogleConfigured,
  isOAuthConfigured,
  parseAllowedDomains,
  sanitizeNextPath,
  type OAuthEnv,
} from "../lib/oauth.js";
import { buildSessionCookie, isSameOrigin, verifySession } from "../lib/session.js";
import { getUser, normalizeEmail, type UsersEnv } from "../lib/users.js";
import { verifyPassword } from "../lib/password.js";
import { ipKey, rateLimit } from "../lib/ratelimit.js";

type Env = OAuthEnv & UsersEnv;

const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_WINDOW_SECONDS = 60;

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loginPage(opts: {
  next: string;
  domains: string[];
  configured: boolean;
  googleEnabled: boolean;
  passwordEnabled: boolean;
  error?: string;
  success?: string;
  alreadyAuthedEmail?: string;
  emailValue?: string;
}): string {
  const {
    next,
    domains,
    configured,
    googleEnabled,
    passwordEnabled,
    error,
    success,
    alreadyAuthedEmail,
    emailValue,
  } = opts;
  const nextEnc = encodeURIComponent(next);
  const domainsHtml = domains
    .map((d) => `<code>@${htmlEscape(d)}</code>`)
    .join(", ");
  const errBlock = error ? `<div class="auth-error">${htmlEscape(error)}</div>` : "";
  const okBlock = success ? `<div class="auth-success">${htmlEscape(success)}</div>` : "";
  const sessionBlock = alreadyAuthedEmail
    ? `<p class="auth-already">Sesión actual: <strong>${htmlEscape(alreadyAuthedEmail)}</strong>. <a href="/auth/logout?next=${nextEnc}">Cerrar sesión</a> para entrar con otra cuenta.</p>`
    : "";
  const emailAttr = emailValue ? ` value="${htmlEscape(emailValue)}"` : "";

  const googleBtn = googleEnabled
    ? `<a class="auth-cta auth-cta--google" href="${htmlEscape(`/auth/start?next=${nextEnc}`)}">
         <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
           <path fill="#4285f4" d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.92a8.8 8.8 0 0 0 2.68-6.61z"/>
           <path fill="#34a853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
           <path fill="#fbbc05" d="M3.97 10.71A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.16.29-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3.01-2.33z"/>
           <path fill="#ea4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A9 9 0 0 0 9 0 9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
         </svg>
         <span>Continuar con Google</span>
       </a>`
    : "";

  const dividerHtml = googleEnabled && passwordEnabled
    ? `<div class="auth-divider"><span>o</span></div>`
    : "";

  const passwordForm = passwordEnabled
    ? `<form class="auth-form" method="post" action="/auth/login?next=${nextEnc}">
         <div class="auth-field">
           <label for="email">Correo</label>
           <input id="email" name="email" type="email" required autocomplete="email" inputmode="email" autocapitalize="none"${emailAttr} />
         </div>
         <div class="auth-field">
           <label for="password">Contraseña</label>
           <input id="password" name="password" type="password" required autocomplete="current-password" />
         </div>
         <button type="submit" class="auth-submit">Entrar</button>
       </form>
       <p class="auth-link-row">¿Sin cuenta? <a href="/auth/register?next=${nextEnc}">Crear cuenta</a></p>`
    : "";

  const ctaHtml = configured
    ? `${googleBtn}${dividerHtml}${passwordForm}`
    : `<div class="auth-error">El acceso aún no está configurado en el servidor. Falta <code>SESSION_SIGNING_SECRET</code> o credenciales OAuth.</div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Iniciar sesión — Showroom Foton</title>
  <link rel="preload" as="font" type="font/woff2" href="/fonts/lato-400.woff2" crossorigin />
  <link rel="preload" as="font" type="font/woff2" href="/fonts/lato-700.woff2" crossorigin />
  <style>
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
    .auth-cta { display: inline-flex; align-items: center; gap: 0.65rem; width: 100%;
      justify-content: center; padding: 0.85rem 1.05rem;
      border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 0.95rem;
      transition: background 0.18s ease, transform 0.12s ease, border-color 0.18s ease; margin-bottom: 0; }
    .auth-cta--google { background: #fff; color: #1a1a1c; }
    .auth-cta--google:hover { background: rgba(255,255,255,0.9); }
    .auth-cta:active { transform: scale(0.98); }
    .auth-divider { display: flex; align-items: center; gap: 0.65rem; margin: 1.1rem 0; font-size: 0.78rem; color: rgba(236,236,239,0.45); }
    .auth-divider::before, .auth-divider::after { content: ""; flex: 1; height: 1px; background: rgba(255,255,255,0.08); }
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
    .auth-domains { margin-top: 1.5rem; font-size: 0.82rem; color: rgba(236,236,239,0.55); }
    .auth-domains code { background: rgba(255,255,255,0.07); padding: 0.1em 0.45em; border-radius: 4px;
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; }
    .auth-error { background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.3); color: #fca5a5;
      padding: 0.85rem 1rem; border-radius: 10px; font-size: 0.88rem; margin-bottom: 1.25rem; }
    .auth-success { background: rgba(74,222,128,0.08); border: 1px solid rgba(74,222,128,0.3); color: #86efac;
      padding: 0.85rem 1rem; border-radius: 10px; font-size: 0.88rem; margin-bottom: 1.25rem; }
    .auth-already { font-size: 0.82rem; color: rgba(236,236,239,0.65); margin: -0.4rem 0 1.3rem; }
    .auth-already a { color: #fff; }
    .auth-foot { margin-top: 2rem; font-size: 0.78rem; color: rgba(236,236,239,0.45); text-align: center; }
    .auth-foot a { color: rgba(236,236,239,0.7); }
  </style>
</head>
<body>
  <main class="auth-shell">
    <div class="auth-card">
      <p class="auth-eyebrow">Showroom Foton</p>
      <h1 class="auth-title">Iniciar sesión</h1>
      <p class="auth-desc">El manual del proyecto y el editor de IA están restringidos al equipo del proyecto.</p>
      ${errBlock}
      ${okBlock}
      ${sessionBlock}
      ${ctaHtml}
      <p class="auth-domains">Solo se permite ingresar con cuentas de los dominios: ${domainsHtml}.</p>
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
  const { request, env } = context;
  const url = new URL(request.url);
  const next = sanitizeNextPath(url.searchParams.get("next"));
  const error = url.searchParams.get("error") ?? undefined;
  const verified = url.searchParams.get("verified") === "1";

  let alreadyAuthedEmail: string | undefined;
  if (env.SESSION_SIGNING_SECRET) {
    const session = await verifySession(request, env.SESSION_SIGNING_SECRET);
    if (session) alreadyAuthedEmail = session.email;
  }

  const passwordEnabled = !!env.MANIFEST_KV && !!env.SESSION_SIGNING_SECRET?.trim();
  const body = loginPage({
    next,
    domains: parseAllowedDomains(env),
    configured: isOAuthConfigured(env) || passwordEnabled,
    googleEnabled: isGoogleConfigured(env) && !!env.SESSION_SIGNING_SECRET?.trim(),
    passwordEnabled,
    error,
    success: verified ? "Cuenta verificada. Inicia sesión con tu correo y contraseña." : undefined,
    alreadyAuthedEmail,
  });

  return htmlResponse(body);
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const next = sanitizeNextPath(url.searchParams.get("next"));
  const secret = env.SESSION_SIGNING_SECRET?.trim();
  const passwordEnabled = !!env.MANIFEST_KV && !!secret;

  const renderErr = (msg: string, emailValue?: string, status = 401): Response =>
    htmlResponse(
      loginPage({
        next,
        domains: parseAllowedDomains(env),
        configured: isOAuthConfigured(env) || passwordEnabled,
        googleEnabled: isGoogleConfigured(env) && !!secret,
        passwordEnabled,
        error: msg,
        emailValue,
      }),
      status
    );

  if (!passwordEnabled) {
    return renderErr("El inicio de sesión por correo no está disponible.", undefined, 503);
  }

  /**
   * Same-origin guard. SameSite=Lax sends cookies on top-level POST so
   * login CSRF is technically possible without this — a malicious page
   * could auto-submit attacker credentials to log the victim into the
   * attacker's account.
   */
  if (!isSameOrigin(request)) {
    return renderErr("Solicitud rechazada (origen distinto).", undefined, 403);
  }

  /** Per-IP rate limit slows credential-stuffing scripts. */
  const rl = await rateLimit(env.MANIFEST_KV!, ipKey(request, "login"), LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SECONDS);
  if (!rl.allowed) {
    const res = htmlResponse(
      loginPage({
        next,
        domains: parseAllowedDomains(env),
        configured: isOAuthConfigured(env) || passwordEnabled,
        googleEnabled: isGoogleConfigured(env) && !!secret,
        passwordEnabled,
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
    return renderErr("Formulario inválido.", undefined, 400);
  }

  const rawEmail = (form.get("email") ?? "").toString();
  const password = (form.get("password") ?? "").toString();
  const email = normalizeEmail(rawEmail);
  if (!email || !password) {
    return renderErr("Falta correo o contraseña.", rawEmail, 400);
  }

  const user = await getUser(env.MANIFEST_KV!, email);
  /**
   * Generic error for both "user doesn't exist" and "wrong password" so we
   * don't leak which emails have accounts. The pending-status branch is the
   * exception — telling the user "verify your email" is more helpful than
   * a misleading credential error.
   */
  if (!user) {
    return renderErr("Correo o contraseña incorrectos.", rawEmail);
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return renderErr("Correo o contraseña incorrectos.", rawEmail);
  }
  if (user.status !== "active") {
    return renderErr(
      "Tu cuenta aún no está verificada. Abre el enlace que enviamos por correo (o regístrate de nuevo si venció).",
      rawEmail,
      403
    );
  }

  const cookie = await buildSessionCookie(user.email, secret!);
  return new Response(null, {
    status: 302,
    headers: {
      Location: next,
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
    },
  });
};
