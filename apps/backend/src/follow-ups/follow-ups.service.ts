import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DateTime } from 'luxon';
import { RequestContextService } from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';

export const FOLLOW_UPS_QUEUE = 'follow-ups';

// Motor de follow-up post-atención (satisfacción).
// Cuando una cita pasa a ATENDIDA, encolamos un job con delay
// `professional.followUpDelayHours`. El processor manda un mensaje al paciente
// pidiéndole que puntúe la experiencia (1-5). Ver ADR 0012.
@Injectable()
export class FollowUpsService {
  private readonly logger = new Logger(FollowUpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: Queue,
    private readonly ctx: RequestContextService,
  ) {}

  // Encola el follow-up de una cita ATENDIDA. Idempotente por jobId derivado del
  // appointmentId — si ya hay un job programado (retry de PATCH status, etc.)
  // BullMQ ignora la insercion duplicada.
  async scheduleForAppointment(appointmentId: string): Promise<void> {
    const appt = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { professional: true },
    });
    if (!appt) return;

    // Config a nivel profesional (default: off). Si el operador nunca prendió
    // follow-ups para este pro, no hacemos nada — evita spam accidental cuando
    // se hace ATENDIDA masivo.
    if (!appt.professional.followUpEnabled) return;

    // Si ya existe feedback (ej. re-marcado a ATENDIDA después de una respuesta
    // manual), no volvemos a molestar.
    //
    // El `clinicId` va en el `where` aunque `appointmentId` sea unique: sin él,
    // una fila envenenada de otro tenant haría que esta clínica no recibiera
    // nunca el prompt de su propia cita — denegación silenciosa.
    const existing = await this.prisma.feedback.findFirst({
      where: { appointmentId, clinicId: appt.clinicId },
      select: { id: true },
    });
    if (existing) return;

    const delay = Math.max(0, appt.professional.followUpDelayHours) * 3_600_000;
    await this.queue.add(
      'send-follow-up',
      {
        appointmentId,
        requestId: this.ctx.get('requestId'),
        clinicId: appt.clinicId,
      },
      {
        delay,
        // Un follow-up por cita. BullMQ ignora duplicados por jobId.
        jobId: `follow-up-${appointmentId}`,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    this.logger.log(
      `follow-up encolado apptId=${appointmentId} delayH=${appt.professional.followUpDelayHours}`,
    );
  }

  // Cancela el follow-up si la cita se revierte (ATENDIDA → CANCELADA por error
  // administrativo, por ejemplo). Silent-fail — el job ya podría haberse enviado.
  async cancelForAppointment(appointmentId: string): Promise<void> {
    const job = await this.queue.getJob(`follow-up-${appointmentId}`);
    await job?.remove().catch(() => undefined);
  }

  /**
   * Persiste la respuesta del paciente. `appointmentId` es unique en Feedback,
   * así que la 2da respuesta se descarta silenciosamente (upsert-ish sin update).
   *
   * **Verifica que la cita sea de esta clínica antes de escribir.** `Feedback`
   * tiene FKs separadas a `Clinic` y a `Appointment`, así que nada en la base
   * impide una fila con `clinicId` de un tenant y `appointmentId` de otro. El
   * `appointmentId` llega desde `Conversation.flowData`, que es JSON durable
   * escrito por el processor: si alguna vez queda uno cruzado (dato viejo, un
   * bug futuro que copie `flowData`, una edición manual), el daño sería doble —
   * el panel de la clínica A leería el score y el comentario en texto libre de
   * un paciente de la clínica B (`@@index([clinicId, respondedAt])`), y como
   * `appointmentId` es unique, la clínica B no podría registrar nunca el
   * feedback real de esa cita.
   *
   * Ante un cruce devolvemos `created: false` y logueamos en `error`, en vez de
   * lanzar: el caller es el webhook del bot, y una excepción ahí es un 500 que
   * WAHA reintenta en bucle sobre un `flowData` que no se va a arreglar solo.
   * El paciente ve el mismo cierre amable que ante un feedback duplicado.
   */
  async recordFeedback(
    clinicId: string,
    appointmentId: string,
    score: number,
    comment?: string,
  ): Promise<{ created: boolean }> {
    if (score < 1 || score > 5) {
      throw new Error(`score fuera de rango [1-5]: ${score}`);
    }
    if (!(await this.appointmentBelongsToClinic(clinicId, appointmentId))) {
      this.logger.error(
        `feedback cross-tenant descartado clinicId=${clinicId} apptId=${appointmentId}`,
      );
      return { created: false };
    }
    try {
      await this.prisma.feedback.create({
        data: {
          clinicId,
          appointmentId,
          score,
          comment: comment?.trim() || null,
          respondedAt: DateTime.now().toJSDate(),
        },
      });
      return { created: true };
    } catch (e) {
      // P2002 (unique) → ya había feedback: es la 2da respuesta del paciente al
      // mismo prompt, no un error. P2003/P2025 → la cita desapareció entre el
      // chequeo y el insert. Los tres se resuelven igual: `created: false`, que
      // el caller traduce en un cierre amable. Lanzar sería un 500 en el
      // webhook y un bucle de reintentos de WAHA por algo irrecuperable.
      const msg = (e as Error).message;
      if (
        msg.includes('Unique') ||
        msg.includes('P2002') ||
        msg.includes('P2003') ||
        msg.includes('P2025')
      ) {
        return { created: false };
      }
      throw e;
    }
  }

  /**
   * Guarda el comentario en texto libre del feedback ya creado, acotado a la
   * clínica. Devuelve `false` si no había fila que actualizar (o era de otro
   * tenant).
   *
   * `updateMany` en vez de `update`, y NO porque `update` no admita el filtro:
   * con `extendedWhereUnique` (GA desde Prisma 5.0, aquí estamos en 5.20)
   * `update({ where: { appointmentId, clinicId } })` compila y filtra igual de
   * bien. La razón es qué pasa cuando no hay match: `update` lanza **P2025** y
   * eso sube al webhook del bot como un 500 que WAHA reintenta en bucle, que es
   * justo lo que evitamos en `recordFeedback`. `updateMany` devuelve
   * `count: 0` y nos deja decidir. De regalo, cubre también la cita borrada
   * entre el score y el comentario, no sólo el cruce de tenant.
   *
   * TODO: `bot.service.ts` (`handleAwaitingNpsComment`) todavía hace
   * `prisma.feedback.update({ where: { appointmentId } })` a pelo, sin
   * `clinicId`. Ese archivo es de la sesión A durante el P1; este método existe
   * para que el cambio allí sea de una línea.
   */
  async recordComment(
    clinicId: string,
    appointmentId: string,
    comment: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.feedback.updateMany({
      where: { appointmentId, clinicId },
      // `|| null` para que un comentario en blanco quede igual que en
      // `recordFeedback` y el panel muestre "sin comentario", no una celda vacía.
      data: { comment: comment.trim().slice(0, 1000) || null },
    });
    if (count === 0) {
      this.logger.warn(
        `comentario de feedback sin fila que actualizar clinicId=${clinicId} apptId=${appointmentId}`,
      );
    }
    return count > 0;
  }

  /**
   * ¿La cita pertenece a esta clínica? `findFirst` con las dos condiciones en
   * el `where`, nunca `findUnique` por id y comparar después.
   *
   * La ventana entre comprobar y escribir es inofensiva aquí: una cita no
   * cambia de clínica en toda su vida.
   */
  private async appointmentBelongsToClinic(
    clinicId: string,
    appointmentId: string,
  ): Promise<boolean> {
    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      select: { id: true },
    });
    return appt !== null;
  }
}
