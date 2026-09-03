import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';
import { Worker, Job } from 'bullmq';
import { DateTime } from 'luxon';
import { requestContext } from '../common/logger/request-context';
import { isSentryEnabled } from '../common/sentry/sentry.config';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { REMINDERS_QUEUE } from './reminders.service';

/**
 * Procesa los jobs de la cola de recordatorios.
 * - send-reminder: envía el mensaje de confirmación por WhatsApp.
 * - check-risk: si la cita no fue confirmada, la marca EN_RIESGO y alerta.
 */
type RemindersJobData = {
  requestId?: unknown;
  clinicId?: unknown;
  reminderId?: unknown;
  appointmentId?: unknown;
};

type RiskAppointment = Prisma.AppointmentGetPayload<{
  include: {
    clinic: true;
    patient: true;
    service: true;
    professional: true;
  };
}>;

export function createRemindersWorker(
  connection: { host: string; port: number },
  prisma: PrismaService,
  waha: WahaService,
): Worker<RemindersJobData> {
  const logger = new Logger('RemindersWorker');

  return new Worker(
    REMINDERS_QUEUE,
    async (job: Job<RemindersJobData>) => {
      // Hidrata el requestContext con datos del producer (populados en
      // reminders.service.ts al hacer queue.add) — permite que los logs del
      // job y sus llamadas downstream compartan requestId + clinicId con el
      // request HTTP que originó el schedule.
      const store = {
        requestId:
          typeof job.data.requestId === 'string'
            ? job.data.requestId
            : randomUUID(),
        clinicId:
          typeof job.data.clinicId === 'string'
            ? job.data.clinicId
            : undefined,
      };
      return await requestContext.run(store, async () => {
        try {
          return await handle(job);
        } catch (err) {
          if (isSentryEnabled()) {
            Sentry.captureException(err, {
              tags: {
                queue: REMINDERS_QUEUE,
                jobName: job.name,
                jobId: String(job.id ?? '?'),
                attempt: String(job.attemptsMade + 1),
                ...(store.clinicId ? { clinicId: store.clinicId } : {}),
              },
              extra: { requestId: store.requestId, data: job.data },
            });
          }
          // Rethrow para respetar la política de retry de BullMQ.
          throw err;
        }
      });
    },
    { connection },
  );

  async function handle(job: Job<RemindersJobData>): Promise<void> {
    if (job.name === 'send-reminder') {
      const reminderId =
        typeof job.data.reminderId === 'string' ? job.data.reminderId : null;
      if (!reminderId) {
        logger.warn(`send-reminder sin reminderId válido jobId=${job.id ?? '?'}`);
        return;
      }

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
      logger.log(
        `Recordatorio enviado (cita ${appt.id}, offset ${reminder.offsetH}h)`,
      );
      return;
    }

    if (job.name === 'check-risk') {
      const appointmentId =
        typeof job.data.appointmentId === 'string'
          ? job.data.appointmentId
          : null;
      if (!appointmentId) {
        logger.warn(`check-risk sin appointmentId válido jobId=${job.id ?? '?'}`);
        return;
      }

      const appt = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          clinic: true,
          patient: true,
          service: true,
          professional: true,
        },
      });
      if (!appt) return;

      const updated = await prisma.appointment.updateMany({
        where: { id: appointmentId, status: 'PENDIENTE' },
        data: { status: 'EN_RIESGO' },
      });
      if (updated.count === 0) return;

      await alertReception(appt);
      logger.warn(`Cita ${appointmentId} EN_RIESGO (sin confirmar).`);
      return;
    }

    logger.warn(`Job de recordatorios desconocido: ${job.name}`);
  }

  async function alertReception(appt: RiskAppointment): Promise<void> {
    const conversation = await prisma.conversation.findFirst({
      where: {
        clinicId: appt.clinicId,
        OR: [{ patientId: appt.patientId }, { phone: appt.patient.phone }],
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });

    if (!conversation) {
      logger.warn(
        `Cita ${appt.id} EN_RIESGO sin conversación asociada para alertar recepción.`,
      );
      return;
    }

    const when = DateTime.fromJSDate(appt.startAt)
      .setZone(appt.clinic.timezone)
      .setLocale(appt.clinic.locale)
      .toFormat("cccc d 'de' LLLL, HH:mm");
    const patientName = appt.patient.name ?? appt.patient.phone;
    const body =
      `⚠️ Alerta recepción: cita EN_RIESGO sin confirmar.\n` +
      `Paciente: ${patientName}\n` +
      `Servicio: ${appt.service.name}\n` +
      `Profesional: ${appt.professional.name}\n` +
      `Horario: ${when}`;

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        state: 'NEEDS_HUMAN',
        flowStep: null,
        messages: {
          create: {
            direction: 'OUT',
            body,
          },
        },
      },
    });
  }
}
