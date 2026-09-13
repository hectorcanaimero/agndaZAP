import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { DateTime } from 'luxon';
import { botCopy, fillConfirmAppointment } from '../bot/bot.messages';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from './rate-limit.guard';
import { WahaService } from '../whatsapp/waha.service';

export type PatientNoticeKind = 'created' | 'rescheduled' | 'canceled';

/**
 * Avisa por WhatsApp al paciente cuando agenda, mueve o cancela su cita desde
 * la web (ADR 0024).
 *
 * Con el bot link-first el chat ya no cierra la reserva: manda un link. Sin este
 * aviso el paciente volvía a WhatsApp y no encontraba ningún "listo".
 *
 * Reglas:
 *  - **Solo a quien ya tiene conversación con la clínica.** Nunca abre un chat
 *    nuevo desde un formulario público: cualquiera puede escribir el teléfono de
 *    otro, y convertir el número de la clínica en un emisor de mensajes no
 *    pedidos es la vía rápida a un baneo de WAHA.
 *  - **Sin prueba de que el chat es suyo, solo si escribió hace poco.** Si la
 *    conversación sale de la cita (`conversationId`, token válido y guarda de
 *    persona superada) se avisa siempre. Si sale de buscar por `patientId` o
 *    teléfono —que pudo escribir un tercero en el formulario—, solo con un
 *    mensaje entrante en las últimas 24 h. Sin esto, crear y cancelar desde la
 *    web en bucle con el teléfono de un paciente le mandaba dos WhatsApp por
 *    vuelta desde el número de la clínica.
 *  - **Topes en Redis**: un aviso por cita, tipo y horario (dedupe), y como
 *    mucho `MAX_PER_CONVERSATION_PER_HOUR` por conversación. Fail-closed: sin
 *    Redis no se avisa. Callar cuesta un "listo"; avisar sin tope, el número.
 *  - Se manda al `chatId` de esa conversación, no al teléfono del formulario:
 *    es el que verificó WhatsApp, y el único que existe en un chat `@lid`.
 *  - Se manda aunque la conversación esté con una persona (`HUMAN` o
 *    `NEEDS_HUMAN`): es una notificación transaccional, como el recordatorio,
 *    no una respuesta del bot.
 *  - **Nunca lanza.** La cita ya está hecha cuando se llama; perder el aviso es
 *    malo, pero no puede tumbar la respuesta HTTP. El caller lo invoca sin
 *    esperar, así que tampoco la retrasa si WAHA tarda.
 */
@Injectable()
export class PatientWhatsappNotifier {
  private readonly logger = new Logger(PatientWhatsappNotifier.name);

  /** Crear, mover dos veces y cancelar en la misma hora es un paciente real. */
  static readonly MAX_PER_CONVERSATION_PER_HOUR = 4;
  /** Ventana de "escribió hace poco", la misma que la sesión de WhatsApp. */
  static readonly RECENT_INBOUND_HOURS = 24;
  static readonly SEND_TIMEOUT_MS = 10_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly waha: WahaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** @returns `true` si el aviso salió; `false` si no había a quién o falló. */
  async notify(input: {
    clinicId: string;
    appointmentId: string;
    kind: PatientNoticeKind;
    /** Link de gestión para crear y mover. Sin él, el texto cae al fallback. */
    manageUrl?: string | null;
  }): Promise<boolean> {
    const { clinicId, appointmentId, kind } = input;
    try {
      const appt = await this.prisma.appointment.findFirst({
        where: { id: appointmentId, clinicId },
        select: {
          status: true,
          startAt: true,
          patientId: true,
          conversationId: true,
          patient: { select: { phone: true } },
          service: { select: { name: true } },
          professional: { select: { name: true } },
          clinic: {
            select: {
              name: true,
              address: true,
              timezone: true,
              locale: true,
              wahaSession: true,
            },
          },
        },
      });
      if (!appt) return false;

      // Mismo orden que `alertReception`: la conversación de la que nació la
      // cita, y si no, la del paciente por `patientId` o teléfono.
      const conversation = await this.prisma.conversation.findFirst({
        where: appt.conversationId
          ? { id: appt.conversationId, clinicId }
          : {
              clinicId,
              OR: [{ patientId: appt.patientId }, { phone: appt.patient.phone }],
            },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, chatId: true },
      });
      if (!conversation) return false;

      if (!appt.conversationId) {
        const recentInbound = await this.prisma.message.findFirst({
          where: {
            conversationId: conversation.id,
            direction: 'IN',
            createdAt: {
              gte: DateTime.now()
                .minus({ hours: PatientWhatsappNotifier.RECENT_INBOUND_HOURS })
                .toJSDate(),
            },
          },
          select: { id: true },
        });
        if (!recentInbound) return false;
      }

      if (!(await this.claimQuota(clinicId, appointmentId, kind, appt.startAt, conversation.id))) {
        return false;
      }

      const text = this.render(appt, kind, input.manageUrl ?? null);
      // Con tope de tiempo: esto va sin `await` desde el controller y no
      // reintenta, así que una sesión de WAHA colgada no puede acumular
      // peticiones abiertas (~300 s de undici sin él).
      await this.waha.sendText(appt.clinic.wahaSession, conversation.chatId, text, {
        timeoutMs: PatientWhatsappNotifier.SEND_TIMEOUT_MS,
      });
      await this.prisma.message.create({
        data: { conversationId: conversation.id, direction: 'OUT', body: text },
      });
      return true;
    } catch (e) {
      // Solo el tipo de error, nunca `message`: el de Prisma incluye los
      // argumentos de la llamada, o sea el texto con el link de gestión.
      const code = (e as { code?: unknown }).code;
      this.logger.warn(
        `no se pudo avisar al paciente por WhatsApp clinicId=${clinicId} apptId=${appointmentId} kind=${kind} err=${(e as Error).name}${typeof code === 'string' ? ` code=${code}` : ''}`,
      );
      return false;
    }
  }

  /**
   * Dedupe por cita+tipo+horario (dos cancelaciones simultáneas con el mismo
   * token avisan una vez; dos cambios de horario legítimos, dos) y tope por
   * conversación. Lanza si Redis falla, y el `catch` de `notify` no envía.
   */
  private async claimQuota(
    clinicId: string,
    appointmentId: string,
    kind: PatientNoticeKind,
    startAt: Date,
    conversationId: string,
  ): Promise<boolean> {
    const dedupe = await this.redis.set(
      `notice:dedupe:${clinicId}:${appointmentId}:${kind}:${startAt.getTime()}`,
      '1',
      'EX',
      24 * 60 * 60,
      'NX',
    );
    if (dedupe === null) return false;

    // `SET NX EX` crea la ventana con su TTL en un solo comando e `INCR`
    // conserva el TTL. Con `INCR` + `EXPIRE` aparte, morir entre los dos dejaba
    // la clave sin caducidad y la conversación sin avisos para siempre.
    const countKey = `notice:conv:${clinicId}:${conversationId}`;
    await this.redis.set(countKey, '0', 'EX', 60 * 60, 'NX');
    const count = await this.redis.incr(countKey);
    if (count > PatientWhatsappNotifier.MAX_PER_CONVERSATION_PER_HOUR) {
      this.logger.warn(
        `tope de avisos por conversación alcanzado clinicId=${clinicId} apptId=${appointmentId} kind=${kind}`,
      );
      return false;
    }
    return true;
  }

  private render(
    appt: {
      status: string;
      startAt: Date;
      service: { name: string };
      professional: { name: string };
      clinic: { name: string; address: string | null; timezone: string; locale: string };
    },
    kind: PatientNoticeKind,
    manageUrl: string | null,
  ): string {
    const copy = botCopy(appt.clinic.locale);
    if (kind === 'canceled') return copy.appointmentCanceled;

    const status =
      kind === 'rescheduled'
        ? copy.status.moved
        : appt.status === 'CONFIRMADA'
          ? copy.status.confirmed
          : copy.status.scheduled;
    // Mismo formato que el cierre de la FSM del bot, en la TZ de la clínica.
    const when = DateTime.fromJSDate(appt.startAt, { zone: appt.clinic.timezone })
      .setLocale(appt.clinic.locale)
      .toFormat(copy.whenFormat);

    return fillConfirmAppointment(copy, copy.pools.confirmAppointment[0], {
      status,
      when,
      clinicName: appt.clinic.name,
      address: appt.clinic.address ? copy.addressLine(appt.clinic.address) : '',
      service: appt.service.name,
      professional: appt.professional.name,
      manageUrl,
    });
  }
}
