import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { parseRedis } from '../reminders/reminders.module';

/**
 * Cola del retorno automático tras un handoff (M7).
 *
 * `NEEDS_HUMAN` silencia al bot hasta que alguien libera la conversación desde
 * el panel. Si nadie la toma —fin de semana, una recepcionista de baja, un
 * handoff a las 21:00— el paciente se queda esperando sin respuesta y sin saber
 * que nadie la va a dar. Este job cierra ese agujero: avisa y devuelve el
 * control al bot, que al menos puede agendar.
 */
export const HANDOFF_QUEUE = 'handoff-timeout';

export const HANDOFF_QUEUE_TOKEN = Symbol('HANDOFF_QUEUE');

/** Horas sin que nadie tome la conversación antes de devolverla al bot. */
export const HANDOFF_TIMEOUT_HOURS = 4;

export interface HandoffTimeoutJobData {
  conversationId: string;
  clinicId: string;
}

export type HandoffQueue = Queue<HandoffTimeoutJobData>;

/**
 * Provee la `Queue` del timeout de handoff como singleton.
 *
 * `jobId` derivado de la conversación: si el paciente pide humano tres veces
 * seguidas no programamos tres retornos. BullMQ ignora el duplicado mientras el
 * job siga vivo.
 */
@Module({
  providers: [
    {
      provide: HANDOFF_QUEUE_TOKEN,
      useFactory: (): HandoffQueue =>
        new Queue(HANDOFF_QUEUE, {
          connection: parseRedis(),
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: 100,
            attempts: 3,
            backoff: { type: 'exponential', delay: 30_000 },
          },
        }),
    },
  ],
  exports: [HANDOFF_QUEUE_TOKEN],
})
export class HandoffQueueModule {}
