import { Logger } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { FOLLOW_UPS_QUEUE } from './follow-ups.service';

// Processor de follow-ups post-atención.
// send-follow-up: manda el prompt "¿Cómo fue tu experiencia?" (1-5) al paciente
// y deja la conversation en `flowStep=AWAITING_NPS_SCORE` para que el
// BotService interprete la próxima respuesta como un score.
export function createFollowUpsWorker(
  connection: { host: string; port: number },
  prisma: PrismaService,
  waha: WahaService,
): Worker {
  const logger = new Logger('FollowUpsWorker');

  return new Worker(
    FOLLOW_UPS_QUEUE,
    async (job: Job) => {
      if (job.name !== 'send-follow-up') return;
      const { appointmentId } = job.data as { appointmentId: string };

      const appt = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          clinic: true,
          patient: true,
          professional: true,
        },
      });
      if (!appt) return;

      // Guard: por si el operador apagó follow-ups DESPUÉS de que la cita fue
      // ATENDIDA pero antes de que el job corriera.
      if (!appt.professional.followUpEnabled) {
        logger.log(`skip apptId=${appointmentId} — followUp desactivado`);
        return;
      }

      // Guard: ya respondió por otro canal (raro, pero posible en dev).
      const existing = await prisma.feedback.findUnique({
        where: { appointmentId },
      });
      if (existing) return;

      const nombre = appt.patient.name ? ` ${appt.patient.name}` : '';
      const text =
        `Hola${nombre}, gracias por tu visita a ${appt.clinic.name}.\n\n` +
        `¿Cómo fue tu experiencia con ${appt.professional.name}? ` +
        `Respondé con un número del *1* (muy mala) al *5* (excelente).`;

      await waha.sendText(appt.clinic.wahaSession, appt.patient.phone, text);

      // Marcamos la conversación para que el BotService interprete la próxima
      // respuesta del paciente como el score. Guardamos el appointmentId en
      // flowData para poder asociar la respuesta después.
      const convo = await prisma.conversation.findFirst({
        where: { clinicId: appt.clinicId, phone: appt.patient.phone },
      });
      if (convo) {
        await prisma.conversation.update({
          where: { id: convo.id },
          data: {
            flowStep: 'AWAITING_NPS_SCORE',
            flowData: { feedbackAppointmentId: appointmentId },
          },
        });
        await prisma.message.create({
          data: { conversationId: convo.id, direction: 'OUT', body: text },
        });
      }

      logger.log(`follow-up enviado apptId=${appointmentId}`);
    },
    { connection },
  );
}
