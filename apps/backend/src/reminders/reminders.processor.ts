import { Logger } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { REMINDERS_QUEUE } from './reminders.service';

/**
 * Procesa los jobs de la cola de recordatorios.
 * - send-reminder: envía el mensaje de confirmación por WhatsApp.
 * - check-risk: si la cita no fue confirmada, la marca EN_RIESGO y alerta.
 */
export function createRemindersWorker(
  connection: { host: string; port: number },
  prisma: PrismaService,
  waha: WahaService,
): Worker {
  const logger = new Logger('RemindersWorker');

  return new Worker(
    REMINDERS_QUEUE,
    async (job: Job) => {
      if (job.name === 'send-reminder') {
        const { reminderId } = job.data;
        const reminder = await prisma.reminder.findUnique({
          where: { id: reminderId },
          include: {
            appointment: {
              include: { clinic: true, patient: true, service: true },
            },
          },
        });
        if (!reminder || reminder.status !== 'SCHEDULED') return;

        const appt = reminder.appointment;
        if (['CANCELADA', 'NO_SHOW'].includes(appt.status)) return;

        const zone = appt.clinic.timezone;
        const when = DateTime.fromJSDate(appt.startAt)
          .setZone(zone)
          .setLocale(appt.clinic.locale)
          .toFormat("cccc d 'de' LLLL, HH:mm");

        const text =
          `Hola${appt.patient.name ? ' ' + appt.patient.name : ''}, te recordamos tu cita ` +
          `de ${appt.service.name} en ${appt.clinic.name} el ${when}.\n\n` +
          `Responde *SÍ* para confirmar, *REAGENDAR* para cambiarla o *CANCELAR*.`;

        await waha.sendText(appt.clinic.wahaSession, appt.patient.phone, text);

        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'SENT', sentAt: DateTime.now().toJSDate() },
        });
        logger.log(`Recordatorio enviado (cita ${appt.id}, offset ${reminder.offsetH}h)`);
      }

      if (job.name === 'check-risk') {
        const { appointmentId } = job.data;
        const appt = await prisma.appointment.findUnique({
          where: { id: appointmentId },
        });
        if (!appt) return;
        if (appt.status === 'PENDIENTE') {
          await prisma.appointment.update({
            where: { id: appointmentId },
            data: { status: 'EN_RIESGO' },
          });
          logger.warn(`Cita ${appointmentId} EN_RIESGO (sin confirmar).`);
          // TODO: emitir evento/notificación a la bandeja del panel.
        }
      }
    },
    { connection },
  );
}
