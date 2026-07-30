/**
 * Thin Resend.com wrapper used by the manual-signup verification flow.
 *
 * Env contract:
 *   - RESEND_API_KEY — `re_…` API key from resend.com → API Keys.
 *   - EMAIL_FROM — either a bare address (`noreply@example.com`) or
 *     a name-formatted address (`Showroom Foton <noreply@…>`). Domain
 *     must be verified on Resend, otherwise use `onboarding@resend.dev`
 *     (sandbox: only delivers to the Resend account owner's address).
 */

export interface EmailEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

export function isEmailConfigured(env: EmailEnv): boolean {
  return !!env.RESEND_API_KEY?.trim() && !!env.EMAIL_FROM?.trim();
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(env: EmailEnv, input: SendEmailInput): Promise<boolean> {
  if (!isEmailConfigured(env)) {
    console.error("[email] not configured — RESEND_API_KEY / EMAIL_FROM missing");
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY!.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM!.trim(),
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[email] resend failed:", res.status, body);
    return false;
  }
  return true;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildVerificationEmail(opts: {
  origin: string;
  email: string;
  token: string;
}): { subject: string; html: string; text: string } {
  const link = `${opts.origin}/auth/verify?token=${encodeURIComponent(opts.token)}`;
  const safeEmail = htmlEscape(opts.email);
  const safeLink = htmlEscape(link);
  const subject = "Confirma tu correo — Showroom Foton";
  const html = `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1c;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#fff;border-radius:14px;padding:32px;">
          <tr><td>
            <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#888;">Showroom Foton</p>
            <h1 style="margin:0 0 14px;font-size:22px;color:#1a1a1c;">Confirma tu correo</h1>
            <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#3a3a3c;">
              Recibimos una solicitud para crear una cuenta con <strong>${safeEmail}</strong>.
              Haz click en el botón para activar tu acceso al manual del proyecto y al editor de IA.
            </p>
            <p style="margin:24px 0;">
              <a href="${safeLink}" style="display:inline-block;background:#1a1a1c;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
                Activar mi cuenta
              </a>
            </p>
            <p style="margin:18px 0 6px;font-size:13px;color:#6e6e73;">
              Si el botón no funciona, copia y pega este enlace en tu navegador:
            </p>
            <p style="margin:0 0 22px;font-size:12px;color:#6e6e73;word-break:break-all;">
              <a href="${safeLink}" style="color:#0a84ff;">${safeLink}</a>
            </p>
            <hr style="border:none;border-top:1px solid #e5e5e7;margin:22px 0;" />
            <p style="margin:0;font-size:12px;color:#888;">
              El enlace vence en 24 horas. Si no solicitaste esta cuenta, ignora este correo.
            </p>
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  const text = `Confirma tu correo — Showroom Foton

Recibimos una solicitud para crear una cuenta con ${opts.email}.
Abre este enlace para activarla (vence en 24 horas):

${link}

Si no solicitaste esta cuenta, ignora este correo.`;
  return { subject, html, text };
}
