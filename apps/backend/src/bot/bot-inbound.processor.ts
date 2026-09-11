import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Worker, Job } from 'bullmq';
import { requestContext } from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { isSentryEnabled } from '../common/sentry/sentry.config';
import type Redis from 'ioredis';
import { hashChatId } from './bot-rate-limit';
import { recordBotStats } from './bot-stats';
import { BotService } from './bot.service';
import { runBotTurn } from './bot-turn-context';
import {
  buildBotTurn,
  emitBotTurn,
  type BotTurnOutcome,
  type BotTurnReason,
} from './bot-turn-event';
import {
  BOT_INBOUND_JOB,
  BOT_INBOUND_QUEUE,
  type BotInboundJobData,
} from './bot-inbound.queue';

/**
 * Etiqueta segura de un error, para logs y Sentry.
 *
 * Excluir `job.data` no basta: el TEXTO del paciente se cuela por el mensaje
 * del propio error. `handleIncoming` hace `prisma.message.create({ body: text })`
 * y los errores de validación de Prisma imprimen los argumentos de la
 * invocación — con el `body` dentro. Ese string acabaría a la vez en Redis
 * (`failedReason` del job), en Axiom y en Sentry.
 *
 * Por eso los errores de Prisma se reducen a `nombre:código`, sin mensaje.
 */
export function safeErrorLabel(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string };
  if (typeof e?.name === 'string' && e.name.startsWith('PrismaClient')) {
    return `${e.name}:${e.code ?? 'sin-código'}`;
  }
  return (e?.message ?? 'unknown').slice(0, 200);
}

/**
 * Worker de los mensajes entrantes de WhatsApp.
 *
 * Antes, el webhook llamaba a `BotService.handleIncoming` en línea y no
 * respondía 200 hasta que el bot terminaba: con el LLM de por medio eso son
 * segundos, y WAHA reintenta el webhook si tarda. El resultado era el mismo
 * mensaje procesado dos veces (doble respuesta, o doble cita).
 *
 * Ahora el webhook encola y responde al instante; el trabajo lento pasa por
 * aquí. Ver [[notas/2026-09-11-cola-bot-inbound]].
 *
 * El `requestId` viaja en el job para poder seguir un mensaje desde la request
 * del webhook hasta la respuesta del bot en los logs — mismo patrón que
 * `reminders.processor` y `follow-ups.processor`.
 */
export function createBotInboundWorker(
  connection: { host: string; port: number },
  bot: BotService,
  prisma: PrismaService,
  redis: Redis,
): Worker {
  const logger = new Logger('BotInboundWorker');

  return new Worker(
    BOT_INBOUND_QUEUE,
    async (job: Job<BotInboundJobData>) => {
      const store = {
        requestId: job.data.requestId ?? randomUUID(),
        clinicId: job.data.clinicId,
      };
      return await requestContext.run(store, async () => {
        try {
          return await handle(job);
        } catch (err) {
          // El último intento es el que importa: si BullMQ va a reintentar, un
          // error transitorio no merece despertar a nadie.
          const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
          if (isSentryEnabled() && isLastAttempt) {
            // Se reporta un error saneado, no el original: su `message` (y la
            // primera línea del stack, que lo repite) pueden llevar el texto
            // del paciente.
            const safe = new Error(safeErrorLabel(err));
            safe.name = (err as Error)?.name ?? 'Error';
            safe.stack = ((err as Error)?.stack ?? '')
              .split('\n')
              .slice(1)
              .join('\n');
            Sentry.captureException(safe, {
              tags: {
                queue: BOT_INBOUND_QUEUE,
                jobName: job.name,
                clinicId: store.clinicId,
                attempt: String(job.attemptsMade + 1),
              },
              // Sin `data`: lleva el texto del paciente y el chatId.
              extra: { requestId: store.requestId },
            });
          }
          if (isLastAttempt) {
            logger.error(
              `mensaje descartado tras ${job.attemptsMade + 1} intentos clinic=${
                store.clinicId
              } requestId=${store.requestId}: ${safeErrorLabel(err)}`,
            );
            // El paciente escribió y no va a recibir nada. Como mínimo que la
            // clínica lo vea: `NEEDS_HUMAN` lo saca en el filtro de triaje del
            // panel. Si esto también falla, no lo dejamos tapar el error real.
            await markNeedsHuman(job.data).catch((e) =>
              logger.error(
                `no se pudo marcar NEEDS_HUMAN clinic=${store.clinicId}: ${safeErrorLabel(e)}`,
              ),
            );
          }
          throw err;
        }
      });
    },
    {
      connection,
      // El default son 30 s, y el job incluye un `sendText` a WAHA. Si WAHA se
      // cuelga, BullMQ marca el job como *stalled* y lo reentrega — pero el
      // `SET NX` del dedup ya está consumido y el jobId es el mismo, así que
      // ese reproceso NO lo para nada: doble respuesta al paciente, que es
      // justo el bug que esta cola viene a arreglar. 120 s cubre el peor caso
      // razonable; `maxStalledCount: 1` evita el bucle infinito si aun así se
      // pasa.
      lockDuration: 120_000,
      maxStalledCount: 1,
      // **Explícito, no por defecto.** La FSM de agendamiento vive en
      // `Conversation.flowStep`: dos mensajes del mismo paciente procesados a
      // la vez se pisarían el paso y la cita saldría con el servicio o el
      // horario equivocado, en silencio. Hoy el default de BullMQ también es 1,
      // pero subirlo "para ir más rápido" rompería la FSM sin ninguna señal.
      concurrency: 1,
    },
  );

  /**
   * Deja la conversación en la bandeja de triaje. Sin esto, un mensaje que
   * agota sus reintentos desaparece: el paciente no recibe respuesta y la
   * clínica no se entera de que escribió.
   */
  async function markNeedsHuman(data: BotInboundJobData): Promise<void> {
    await prisma.conversation.updateMany({
      where: { clinicId: data.clinicId, chatId: data.chatId, state: 'BOT' },
      data: { state: 'NEEDS_HUMAN' },
    });
  }

  async function handle(job: Job<BotInboundJobData>): Promise<void> {
    if (job.name !== BOT_INBOUND_JOB) {
      // Hoy no es alcanzable, pero si alguien renombra la constante los
      // mensajes desaparecerían marcados como completados y sin una línea.
      logger.warn(`job con nombre inesperado, descartado: ${job.name}`);
      emit({ job, outcome: 'skipped', reasonCode: 'job-desconocido' });
      return;
    }
    const { clinicId, chatId, phone, lid, contactName, text } = job.data;

    // El webhook comprobó que la clínica estaba ACTIVE al encolar, pero entre
    // eso y ahora pudo suspenderse (o la cola venir atrasada). Sin revalidar,
    // el bot respondería en nombre de una clínica dada de baja.
    // El `try` no sobra: si Postgres se cae, `handle` reventaba aquí y NO se
    // emitía ningún evento. La clínica vería cero turnos y cero errores, que es
    // indistinguible de "no escribió nadie" — justo durante una caída.
    let clinic: { status: string } | null;
    try {
      clinic = await prisma.clinic.findUnique({
        where: { id: clinicId },
        select: { status: true },
      });
    } catch (err) {
      emit({ job, outcome: 'error', reasonCode: 'bot-error' });
      throw err;
    }
    if (clinic?.status !== 'ACTIVE') {
      logger.log(
        `mensaje descartado: clínica no activa clinic=${clinicId} status=${
          clinic?.status ?? 'inexistente'
        }`,
      );
      emit({
        job,
        outcome: 'skipped',
        reasonCode: 'clinica-no-activa',
      });
      return;
    }

    // El turno se envuelve para poder medir su latencia REAL y para que
    // `BotService` pueda anotar intención, origen y RAG desde dentro sin
    // pasar un parámetro por toda la cadena. Se emite pase lo que pase: un
    // turno que falla es el que más interesa observar.
    const startedAt = Date.now();
    const turn = await runBotTurn(() =>
      bot.handleIncoming({ clinicId, chatId, phone, lid, contactName, text }),
    );
    const latencyMs = Date.now() - startedAt;

    emit({
      job,
      outcome: turn.ok ? 'ok' : 'error',
      latencyMs,
      turn: turn.data,
      ...(turn.ok ? {} : { reasonCode: 'bot-error' as const }),
    });
    if (!turn.ok) throw turn.error;
  }

  /**
   * Una línea por turno (ver `bot-turn-event.ts`) más los contadores que lee
   * el dashboard (`bot-stats.ts`).
   *
   * Los contadores van sin `await`: son una métrica, y no pueden retrasar ni
   * hacer fallar la respuesta a un paciente. `recordBotStats` ya es fail-open
   * por dentro, así que el `catch` aquí es sólo por si la promesa se rechaza
   * de una forma que no previó.
   */
  function emit(input: {
    job: Job<BotInboundJobData>;
    outcome: BotTurnOutcome;
    latencyMs?: number;
    turn?: Parameters<typeof buildBotTurn>[0]['turn'];
    reasonCode?: BotTurnReason;
  }): void {
    const { job, outcome, latencyMs, turn, reasonCode } = input;
    const jobData = job.data;
    // 1-based, y sólo se emite si hubo reintento: un `attempt: 1` en cada
    // línea es ruido.
    const attempt = job.attemptsMade + 1;

    const event = buildBotTurn({
      clinicId: jobData.clinicId,
      chatHash: hashChatId(jobData.chatId, jobData.clinicId),
      outcome,
      latencyMs,
      requestId: jobData.requestId,
      reasonCode,
      ...(attempt > 1 ? { attempt } : {}),
      turn,
    });
    emitBotTurn(logger, event);

    // **Los contadores sólo cuentan el primer intento.** El evento se emite en
    // todos (es lo que hace falta para depurar), pero BullMQ reintenta hasta
    // tres veces: un mensaje que falla dos veces y acierta a la tercera sumaría
    // 3 turnos y 2 errores para UN mensaje del paciente, y el panel de la
    // clínica estaría mintiendo sobre su propio volumen.
    if (attempt === 1) {
      // La TZ sale del job, no de la base: así el contador cae en el día
      // correcto incluso cuando el turno falló porque Postgres no responde.
      void recordBotStats(redis, logger, event, jobData.timezone).catch(
        () => undefined,
      );
    }

  }
}
