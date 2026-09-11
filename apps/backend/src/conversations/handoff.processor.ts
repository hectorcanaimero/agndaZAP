import { Logger } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { HANDOFF_QUEUE, HandoffTimeoutJobData } from './handoff.queue';

/**
 * Devuelve al bot una conversación que nadie del equipo tomó (M7).
 *
 * Es un no-op si la conversación ya no está en `NEEDS_HUMAN`: alguien la
 * atendió, la liberó desde el panel, o el paciente resolvió lo suyo por otra
 * vía. Eso hace innecesario cancelar el job al liberar desde el panel — el
 * estado en DB es la única fuente de verdad, y un job que llega tarde no puede
 * pisar una conversación que ya está en manos de una persona.
 */
export function createHandoffWorker(
  connection: { host: string; port: number },
  prisma: PrismaService,
  waha: WahaService,
): Worker<HandoffTimeoutJobData> {
  const logger = new Logger('HandoffWorker');

  return new Worker(
    HANDOFF_QUEUE,
    async (job: Job<HandoffTimeoutJobData>) => {
      const { conversationId, clinicId } = job.data;

      const convo = await prisma.conversation.findFirst({
        where: { id: conversationId, clinicId },
        include: { clinic: true },
      });
      if (!convo) return;

      // Alguien la tomó: nada que hacer.
      if (convo.state !== 'NEEDS_HUMAN') return;

      const text =
        'Perdona la espera: no pude conectarte con alguien del equipo. ' +
        'Sigo por aquí, así que si quieres puedo ayudarte a *agendar*, *reagendar* o *cancelar* una cita. ' +
        'Y si prefieres esperar a una persona, escribe *humano* y lo vuelvo a intentar.';

      // Devolvemos el control ANTES de escribir: si el sendText falla, la
      // conversación no puede quedarse en NEEDS_HUMAN para siempre por un
      // error de red. Al revés es peor.
      await prisma.conversation.updateMany({
        where: { id: conversationId, clinicId, state: 'NEEDS_HUMAN' },
        data: { state: 'BOT' },
      });

      try {
        await waha.sendText(convo.clinic.wahaSession, convo.chatId, text);
        await prisma.message.create({
          data: { conversationId, direction: 'OUT', body: text },
        });
      } catch (e) {
        logger.error(
          `aviso de retorno no enviado convoId=${conversationId} clinicId=${clinicId}: ${(e as Error).message}`,
        );
      }

      logger.log(
        `conversación devuelta al bot tras el timeout de handoff convoId=${conversationId} clinicId=${clinicId}`,
      );
    },
    { connection },
  );
}
