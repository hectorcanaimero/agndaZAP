import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DateTime } from 'luxon';
import { RequestContextService } from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';

export const REMINDERS_QUEUE = 'reminders';

/**
 * Motor de recordatorios anti no-show.
 * Al crear/confirmar una cita, programa un job BullMQ con delay por cada offset
 * configurado en la clínica (por defecto 24h y 3h antes). Cada job dispara un
 * recordatorio pidiendo confirmación. Un job extra vigila el umbral sin confirmar.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: Queue,
    private readonly ctx: RequestContextService,
  ) {}

  /**
   * SPEC §2 nombra los IDs como `reminder:{id}` y `risk:{apptId}`.
   * BullMQ 5 reserva `:` como separador interno de claves Redis; por eso el
   * jobId físico usa `-`, manteniendo la misma determinación 1:1.
   */
  private reminderJobId(reminderId: string): string {
    return `reminder-${reminderId}`;
  }

  private riskJobId(appointmentId: string): string {
    return `risk-${appointmentId}`;
  }

  // Snapshot del request context — se serializa a job.data para que el worker
  // pueda rehidratar el contexto y correlacionar logs con el request original.
  private jobContextPayload(clinicId?: string): {
    requestId?: string;
    clinicId?: string;
  } {
    return {
      requestId: this.ctx.get('requestId'),
      clinicId: clinicId ?? this.ctx.get('clinicId'),
    };
  }

  /** Programa todos los recordatorios de una cita (idempotente). */
  async scheduleForAppointment(appointmentId: string): Promise<void> {
    const appt = await this.prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: { clinic: true },
    });

    // Cancela recordatorios previos para no duplicar
    await this.cancelForAppointment(appointmentId);

    const offsets = appt.clinic.reminderOffsetsH ?? [24, 3];
    const now = DateTime.utc();
    const startAt = DateTime.fromJSDate(appt.startAt).toUTC();

    for (const offsetH of offsets) {
      const fireAt = startAt.minus({ hours: offsetH });
      if (fireAt <= now) continue; // no programar recordatorios en el pasado

      const reminder = await this.prisma.reminder.create({
        data: {
          appointmentId,
          offsetH,
          fireAt: fireAt.toJSDate(),
          status: 'SCHEDULED',
        },
      });

      const delay = Math.max(0, fireAt.toMillis() - now.toMillis());
      const job = await this.queue.add(
        'send-reminder',
        {
          reminderId: reminder.id,
          ...this.jobContextPayload(appt.clinicId),
        },
        {
          delay,
          jobId: this.reminderJobId(reminder.id),
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: { jobId: job.id },
      });
    }

    // Job que revisa el umbral sin confirmar (EN_RIESGO)
    const threshold = startAt.minus({
      hours: appt.clinic.confirmThresholdH,
    });
    if (threshold > now) {
      await this.queue.add(
        'check-risk',
        {
          appointmentId,
          ...this.jobContextPayload(appt.clinicId),
        },
        {
          delay: threshold.toMillis() - now.toMillis(),
          jobId: this.riskJobId(appointmentId),
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    }
  }

  /** Cancela todos los recordatorios y jobs de una cita. */
  async cancelForAppointment(appointmentId: string): Promise<void> {
    const reminders = await this.prisma.reminder.findMany({
      where: { appointmentId, status: 'SCHEDULED' },
    });
    for (const r of reminders) {
      if (r.jobId) {
        const job = await this.queue.getJob(r.jobId);
        await job?.remove().catch(() => undefined);
      }
    }
    await this.prisma.reminder.updateMany({
      where: { appointmentId, status: 'SCHEDULED' },
      data: { status: 'CANCELED' },
    });
    const riskJob = await this.queue.getJob(this.riskJobId(appointmentId));
    await riskJob?.remove().catch(() => undefined);
  }

  /** Llamado cuando el paciente confirma: marca la cita y detiene el resto. */
  async confirmAppointment(appointmentId: string): Promise<void> {
    await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: 'CONFIRMADA', confirmedAt: DateTime.now().toJSDate() },
    });
    // Los recordatorios ya enviados quedan; los pendientes se mantienen como
    // segundo aviso, pero el check-risk se cancela porque ya confirmó.
    const riskJob = await this.queue.getJob(this.riskJobId(appointmentId));
    await riskJob?.remove().catch(() => undefined);
  }
}
