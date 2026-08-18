import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import {
  buildClinicInvitationEmail,
  type InvitationEmailInput,
} from './templates/clinic-invitation.template';

/**
 * Resultado de un envío. `messageId` viene de Resend en envíos reales;
 * en dev-fallback devolvemos `null` y el consumidor se conforma con `ok`.
 */
export interface SendResult {
  ok: boolean;
  messageId?: string | null;
  /** Solo populado cuando `ok === false`. Nunca contiene PII. */
  error?: string;
}

/**
 * MailService — abstracción del transporte de mails de Showly.
 *
 * Reglas de diseño:
 *
 * - **Dev-fallback**: si no hay `RESEND_API_KEY`, no intentamos conectar —
 *   solo logueamos y devolvemos `{ok:true}`. Motivo: durante dev queremos que
 *   la creación de clínica funcione end-to-end sin exigir API key. El super
 *   ve el link en el response (fallback UI) igual.
 *
 * - **Nunca bloqueante**: los callers usan `.then(...).catch(...)` para
 *   fire-and-forget. Un fallo de mail NO tumba la creación del recurso
 *   (ej: si Resend está caído, la clínica ya está creada y el super copia
 *   el link manualmente).
 *
 * - **Cero PII en logs**: solo logueamos `to.slice(0,3)+'…'` y el messageId
 *   de Resend. Nunca cuerpo del mail ni password.
 *
 * - **Locale-aware**: los templates existen en `es` y `pt`; caemos a `es`
 *   si nos pasan otro locale (defensivo — no debería pasar).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('MailService');
  private readonly client: Resend | null;
  private readonly from: string;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    // `onboarding@resend.dev` funciona sin dominio verificado pero solo puede
    // mandar al email owner de la cuenta Resend. Para prod, setear un dominio
    // verificado (ej: `Showly <no-reply@showly.dev>`).
    this.from = process.env.EMAIL_FROM ?? 'Showly <onboarding@resend.dev>';
    this.client = apiKey ? new Resend(apiKey) : null;
    if (!this.client) {
      this.logger.warn(
        'RESEND_API_KEY no seteada — mails se logean en consola (dev-fallback)',
      );
    }
  }

  /**
   * Envía la invitación a activar cuenta a un CLINIC_ADMIN recién creado.
   * Ver `AdminClinicsService.create()` para el flow completo.
   */
  async sendClinicInvitation(
    input: InvitationEmailInput,
  ): Promise<SendResult> {
    const { subject, html, text } = buildClinicInvitationEmail(input);
    return this.send({
      to: input.to,
      subject,
      html,
      text,
    });
  }

  /**
   * Wrapper genérico. Devuelve `{ok:false, error}` en vez de throw para
   * que los callers puedan decidir sin try/catch — un mail que falla no
   * debería tumbar el request principal.
   */
  private async send(payload: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<SendResult> {
    const toHint = payload.to.slice(0, 3) + '…';

    if (!this.client) {
      this.logger.log(
        `[dev-fallback] mail SKIP to=${toHint} subject="${payload.subject}"`,
      );
      return { ok: true, messageId: null };
    }

    try {
      const res = await this.client.emails.send({
        from: this.from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      });
      if (res.error) {
        this.logger.error(
          `mail send fail to=${toHint} error=${res.error.message}`,
        );
        return { ok: false, error: res.error.message };
      }
      this.logger.log(`mail sent to=${toHint} id=${res.data?.id ?? 'n/a'}`);
      return { ok: true, messageId: res.data?.id ?? null };
    } catch (e) {
      const err = e as Error;
      this.logger.error(`mail send threw to=${toHint} error=${err.message}`);
      return { ok: false, error: err.message };
    }
  }
}
