import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Worker, Job } from 'bullmq';
import { requestContext } from '../common/logger/request-context';
import { phoneToChatId } from '../common/phone.util';
import { isSentryEnabled } from '../common/sentry/sentry.config';
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
      const store = {
        requestId: (job.data.requestId as string) ?? randomUUID(),
        clinicId: (job.data.clinicId as string) ?? undefined,
      };
      return await requestContext.run(store, async () => {
        try {
          return await handle(job);
        } catch (err) {
          if (isSentryEnabled()) {
            Sentry.captureException(err, {
              tags: {
                queue: FOLLOW_UPS_QUEUE,
                jobName: job.name,
                jobId: String(job.id ?? '?'),
                attempt: String(job.attemptsMade + 1),
                ...(store.clinicId ? { clinicId: store.clinicId } : {}),
              },
              extra: { requestId: store.requestId, data: job.data },
            });
          }
          throw err;
        }
      });
    },
    { connection },
  );

  async function handle(job: Job): Promise<void> {
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

      // Conversación destino del prompt. Tiene que existir SIEMPRE: si no la
      // hay, la respuesta "5" del paciente entra al bot sin `flowStep` y cae al
      // clasificador LLM en vez de a la sub-FSM de feedback (el score se pierde
      // y el paciente recibe un fallback sin sentido). Pasa con todo paciente
      // que agendó por la página pública y nunca escribió por WhatsApp.
      //
      // La buscamos ANTES de enviar porque el estado de la conversación decide
      // si el prompt sale o no (ver el guard de HUMAN abajo).
      //
      // Criterio de búsqueda alineado con `alertReception` en
      // `reminders.processor.ts`: por `patientId` O por `phone`, y
      // `orderBy: updatedAt desc`. El `orderBy` no es cosmético — puede haber
      // dos filas para el mismo paciente (una `@lid` y una `@c.us`) y sin él
      // Postgres devuelve cualquiera: el score se perdería de forma
      // intermitente, que es el peor modo de fallo posible.
      const knownConvo = await prisma.conversation.findFirst({
        where: {
          clinicId: appt.clinicId,
          OR: [{ patientId: appt.patientId }, { phone: appt.patient.phone }],
        },
        orderBy: { updatedAt: 'desc' },
      });

      // Guard: un humano está atendiendo esta conversación. No mandamos el
      // prompt automático — se metería en medio de la charla — y tampoco
      // armamos la sub-FSM: `BotService.handleIncoming` corta en seco cuando
      // `state === 'HUMAN'`, así que el score se perdería igual y el `flowStep`
      // quedaría colgado hasta el `release()` del operador. Sin re-encolar: si
      // la conversación sigue en HUMAN el job rebotaría indefinidamente.
      if (knownConvo?.state === 'HUMAN') {
        logger.log(
          `skip apptId=${appointmentId} — conversación atendida por humano`,
        );
        return;
      }

      const nombre = appt.patient.name ? ` ${appt.patient.name}` : '';
      const text =
        `Hola${nombre}, gracias por tu visita a ${appt.clinic.name}.\n\n` +
        `¿Cómo fue tu experiencia con ${appt.professional.name}? ` +
        `Responde con un número del *1* (muy mala) al *5* (excelente).`;

      await waha.sendText(appt.clinic.wahaSession, appt.patient.phone, text);

      // A partir de acá el prompt YA salió por WhatsApp. La cola no tiene
      // `attempts` configurado (ver `follow-ups.module.ts`), así que un throw
      // aquí no se reintenta: dejaría el mensaje entregado y la sub-FSM sin
      // armar, exactamente el bug que este código arregla. Capturamos y
      // reportamos sin re-lanzar — re-lanzar solo perdería la información.
      try {
        const flowData = { feedbackAppointmentId: appointmentId };

        if (knownConvo) {
          await prisma.conversation.update({
            where: { id: knownConvo.id },
            data: {
              flowStep: 'AWAITING_NPS_SCORE',
              flowData,
              // Ligamos el hilo al paciente si nadie lo había hecho. Desde S5
              // ya no es el único sitio que escribe `patientId`: también lo
              // hacen `BotService` al confirmar por la FSM y al resolver por el
              // teléfono verificado (ver
              // docs/notas/2026-09-11-conversation-patient-link.md).
              // Nunca pisamos uno existente.
              //
              // La conversación viene de resolver por `patientId` O por `phone`
              // de la cita (arriba, :98), o sea de datos que ya están en la
              // cita — no de nada que el paciente haya declarado en un
              // formulario. Por eso acá ligar es seguro.
              ...(knownConvo.patientId ? {} : { patientId: appt.patientId }),
            },
          });
          await prisma.message.create({
            data: { conversationId: knownConvo.id, direction: 'OUT', body: text },
          });
        } else {
          // `upsert` por la clave única `(clinicId, chatId)` con el id canónico
          // `<digitos>@c.us` — el mismo que usará WAHA al entregar la
          // respuesta, así el próximo mensaje entrante cae en esta misma fila.
          //
          // Es `upsert` y no `create` para tolerar la carrera con un mensaje
          // entrante entre el `findFirst` y la escritura (`handleIncoming`
          // escribe esta misma clave), y para corregir filas legacy con el
          // `phone` sin `+`.
          //
          // El `flowStep` va DENTRO del upsert, no en una update posterior: en
          // esa ventana el paciente podría escribir, el bot arrancaría la FSM
          // de agendamiento y se la sobreescribiríamos, dejándolo con un
          // "elige un servicio" cuya respuesta se guardaría como score.
          const chatId = phoneToChatId(appt.patient.phone);
          const created = await prisma.conversation.upsert({
            where: { clinicId_chatId: { clinicId: appt.clinicId, chatId } },
            create: {
              clinicId: appt.clinicId,
              chatId,
              phone: appt.patient.phone,
              patientId: appt.patientId,
              state: 'BOT',
              flowStep: 'AWAITING_NPS_SCORE',
              flowData,
            },
            update: {
              phone: appt.patient.phone,
              flowStep: 'AWAITING_NPS_SCORE',
              flowData,
            },
          });
          await prisma.message.create({
            data: { conversationId: created.id, direction: 'OUT', body: text },
          });
        }
      } catch (err) {
        // El paciente ya recibió el prompt; su respuesta caerá al LLM. Queda
        // registrado para poder detectarlo en vez de que falle en silencio.
        logger.error(
          `follow-up enviado pero la sub-FSM no quedó armada apptId=${appointmentId}: ${(err as Error).message}`,
        );
        if (isSentryEnabled()) {
          Sentry.captureException(err, {
            tags: { queue: FOLLOW_UPS_QUEUE, stage: 'arm-nps-fsm' },
            extra: { appointmentId, clinicId: appt.clinicId },
          });
        }
        return;
      }

      logger.log(`follow-up enviado apptId=${appointmentId}`);
  }
}
