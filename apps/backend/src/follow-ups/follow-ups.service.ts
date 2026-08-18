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
    const existing = await this.prisma.feedback.findUnique({
      where: { appointmentId },
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

  // Persiste la respuesta del paciente. `appointmentId` es unique en Feedback,
  // así que la 2da respuesta se descarta silenciosamente (upsert-ish sin update).
  async recordFeedback(
    clinicId: string,
    appointmentId: string,
    score: number,
    comment?: string,
  ): Promise<{ created: boolean }> {
    if (score < 1 || score > 5) {
      throw new Error(`score fuera de rango [1-5]: ${score}`);
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
      // Unique violation → ya había feedback. No es error, es la 2da respuesta
      // del paciente al mismo prompt. El caller decide si le agradece igual.
      const msg = (e as Error).message;
      if (msg.includes('Unique') || msg.includes('P2002')) {
        return { created: false };
      }
      throw e;
    }
  }
}
