/**
 * Template del email de invitación a activar cuenta.
 *
 * Diseño:
 * - HTML self-contained (todo inline, sin CSS externos — clientes mail son
 *   caprichosos con `<style>` y `link[rel=stylesheet]`).
 * - Text-only paralelo — obligatorio para no caer en spam y para clientes
 *   plaintext (gmail móvil ocasionalmente).
 * - Brand tokens hardcoded (navy #0F2A4A / teal #28D9B9) para no importar
 *   tailwind en el backend.
 *
 * Locale: `es` (LATAM neutro, tú) y `pt` (Brasil). Fallback `es`.
 */

export interface InvitationEmailInput {
  to: string;
  /** Nombre del invitado — se usa como saludo. */
  invitedName: string;
  /** Nombre de la clínica a la que se invita. */
  clinicName: string;
  /** URL absoluta al `/invite/{token}`. */
  inviteUrl: string;
  /** Cuándo caduca la invitación. Se muestra fecha localizada. */
  expiresAt: Date;
  /** Idioma del email. */
  locale: 'es' | 'pt';
  /** Nombre de quien invitó (opcional — si no viene se omite del cuerpo). */
  invitedByName?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Formato de fecha localizado corto (día + mes + año). Sin hora — el TTL
 * de la invitación es de 7 días, la precisión al minuto no aporta.
 */
function formatDate(date: Date, locale: 'es' | 'pt'): string {
  return new Intl.DateTimeFormat(locale === 'pt' ? 'pt-BR' : 'es-419', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/**
 * Escapa `<`, `>`, `&`, `"`, `'` en strings que van al HTML. Nunca deberíamos
 * recibir nombres con HTML pero no confiamos — mejor defensivos que sorry.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COPY = {
  es: {
    subject: (clinicName: string) =>
      `Te invitaron a administrar ${clinicName} en Showly`,
    hi: (name: string) => `Hola ${name},`,
    intro: (clinicName: string, invitedBy?: string) =>
      invitedBy
        ? `${escapeHtml(invitedBy)} te invitó a administrar <strong>${escapeHtml(clinicName)}</strong> en Showly.`
        : `Te invitamos a administrar <strong>${escapeHtml(clinicName)}</strong> en Showly.`,
    cta: 'Activá tu cuenta',
    ctaHint: 'Vas a elegir tu contraseña en el siguiente paso.',
    expiresPrefix: 'Este enlace vence el',
    fallbackPrefix: 'Si el botón no funciona, copiá esta dirección en tu navegador:',
    footer: 'Si no esperabas esta invitación, ignorá este email.',
    signature: 'El equipo de Showly',
  },
  pt: {
    subject: (clinicName: string) =>
      `Você foi convidado para administrar ${clinicName} no Showly`,
    hi: (name: string) => `Olá ${name},`,
    intro: (clinicName: string, invitedBy?: string) =>
      invitedBy
        ? `${escapeHtml(invitedBy)} convidou você para administrar <strong>${escapeHtml(clinicName)}</strong> no Showly.`
        : `Convidamos você para administrar <strong>${escapeHtml(clinicName)}</strong> no Showly.`,
    cta: 'Ative sua conta',
    ctaHint: 'Você vai escolher sua senha no próximo passo.',
    expiresPrefix: 'Este link expira em',
    fallbackPrefix: 'Se o botão não funcionar, copie este endereço no seu navegador:',
    footer: 'Se você não esperava este convite, ignore este email.',
    signature: 'A equipe do Showly',
  },
} as const;

export function buildClinicInvitationEmail(
  input: InvitationEmailInput,
): RenderedEmail {
  const l = input.locale === 'pt' ? 'pt' : 'es';
  const copy = COPY[l];
  const invitedName = escapeHtml(input.invitedName);
  const clinicName = escapeHtml(input.clinicName);
  const inviteUrl = input.inviteUrl; // ya URL-encoded upstream
  const expiresStr = formatDate(input.expiresAt, l);

  const subject = copy.subject(input.clinicName);

  const html = `<!doctype html>
<html lang="${l}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0F2A4A;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(15,42,74,0.08);overflow:hidden;">
            <tr>
              <td style="padding:24px 32px 8px 32px;">
                <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em;color:#0F2A4A;">Showly</div>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 8px 32px;font-size:15px;line-height:1.6;color:#0F2A4A;">
                <p style="margin:0 0 12px 0;">${escapeHtml(copy.hi(input.invitedName))}</p>
                <p style="margin:0 0 20px 0;">${copy.intro(input.clinicName, input.invitedByName)}</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 32px 24px 32px;">
                <a href="${inviteUrl}" style="display:inline-block;background:#28D9B9;color:#0F2A4A;font-weight:600;font-size:15px;text-decoration:none;padding:12px 28px;border-radius:8px;">${copy.cta}</a>
                <p style="margin:12px 0 0 0;font-size:12px;color:#6b7280;">${copy.ctaHint}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0 0 12px 0;">${copy.expiresPrefix} <strong>${expiresStr}</strong>.</p>
                <p style="margin:0 0 4px 0;">${copy.fallbackPrefix}</p>
                <p style="margin:0;word-break:break-all;color:#0F2A4A;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;">${inviteUrl}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;line-height:1.6;">
                <p style="margin:0 0 8px 0;">${copy.footer}</p>
                <p style="margin:0;">— ${copy.signature}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  // Plaintext: importante para no ir a spam + accesibilidad. Mismo contenido
  // sin markup, con el link en línea aparte.
  const text = [
    stripHtml(copy.hi(input.invitedName)),
    '',
    stripHtml(copy.intro(input.clinicName, input.invitedByName)),
    '',
    `${copy.cta}: ${inviteUrl}`,
    copy.ctaHint,
    '',
    `${copy.expiresPrefix} ${expiresStr}.`,
    '',
    copy.footer,
    `— ${copy.signature}`,
  ].join('\n');

  // Los nombres crudos van al text sin escape (no hay parser HTML). Pero
  // los ya-escapeados sí tienen `&amp;` etc — los deshacemos para el text.
  const cleanText = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Evitar warning de vars no usadas cuando lo llama el linter.
  void invitedName;
  void clinicName;

  return { subject, html, text: cleanText };
}

/** Remueve tags HTML del copy (que uso para negritas). Solo `<strong>` acá. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
