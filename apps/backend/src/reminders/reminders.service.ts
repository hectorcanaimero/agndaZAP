import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DateTime } from 'luxon';
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
  ) {}

  /** Programa todos los recordatorios de una cita (idempotente). */
  async scheduleForAppointment(appointmentId: string): Promise<void> {
    const appt = await this.prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: { clinic: true },
    });

    // Cancela recordatorios previos para no duplicar
    await this.cancelForAppointment(appointmentId);

    const offsets = appt.clinic.reminderOffsetsH ?? [24, 3];
    const now = DateTime.now();

    for (const offsetH of offsets) {
      const fireAt = DateTime.fromJSDate(appt.startAt).minus({ hours: offsetH });
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
        { reminderId: reminder.id },
        {
          delay,
          // BullMQ 5.x prohíbe `:` en custom job IDs → usamos `-` como separador.
          jobId: `reminder-${reminder.id}`, // idempotencia
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
    const threshold = DateTime.fromJSDate(appt.startAt).minus({
      hours: appt.clinic.confirmThresholdH,
    });
    if (threshold > now) {
      await this.queue.add(
        'check-risk',
        { appointmentId },
        {
          delay: threshold.toMillis() - now.toMillis(),
          jobId: `risk-${appointmentId}`,
          removeOnComplete: true,
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
    const riskJob = await this.queue.getJob(`risk-${appointmentId}`);
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
    const riskJob = await this.queue.getJob(`risk-${appointmentId}`);
    await riskJob?.remove().catch(() => undefined);
  }
}
