import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Worker, Job } from 'bullmq';
import { requestContext } from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { isSentryEnabled } from '../common/sentry/sentry.config';
import type Redis from 'ioredis';
import { hashChatId } from './bot-rate-limit';
import { recordBotStats } from './bot-stats';
import { isSttEnabled } from './bot-inbound.queue';
import {
  AudioTooLongError,
  MediaExpiredError,
  SttService,
  type Transcription,
} from '../stt/stt.service';
import { botCopy, botLocale, VOICE_CONSENT_VERSION } from './bot.messages';
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
/**
 * Copia saneada del error, para todo lo que sale de este proceso.
 *
 * Conserva el `name` (que es lo que se agrupa y por lo que se filtra) y tira el
 * `message` original y la primera línea del stack, que lo repite.
 */
export function sanitizeError(err: unknown): Error {
  const safe = new Error(safeErrorLabel(err));
  safe.name = (err as Error)?.name ?? 'Error';
  safe.stack = ((err as Error)?.stack ?? '').split('\n').slice(1).join('\n');
  return safe;
}

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
  stt: SttService,
  waha: WahaService,
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
            Sentry.captureException(sanitizeError(err), {
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
          // Saneado también al relanzar, no sólo hacia Sentry. BullMQ guarda
          // `message` y `stacktrace` en el `failedReason` del job, en un Redis
          // sin cifrado at-rest: el mismo string que aquí se cuida para el log
          // y para Sentry se estaba escribiendo ahí entero. Con M10 ese
          // `message` puede llevar además la **transcripción** de una nota de
          // voz (un `message.create({ body })` que falle por validación imprime
          // los argumentos) y la URL del media.
          //
          // El `name` sobrevive, que es lo que se mira al depurar; el mensaje
          // completo ya se ha logueado saneado más arriba.
          throw sanitizeError(err);
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
   * La conversación de este chat, con su estado. Es `findFirst` sobre un par
   * que el esquema declara único (`@@unique([clinicId, chatId])`), así que no
   * hay ambigüedad; va con `clinicId` porque el mismo teléfono puede escribirle
   * a dos clínicas distintas.
   */
  async function findConvo(
    data: BotInboundJobData,
  ): Promise<{ id: string; state: string; voiceConsentVersion: string | null } | null> {
    return prisma.conversation.findFirst({
      where: { clinicId: data.clinicId, chatId: data.chatId },
      select: { id: true, state: true, voiceConsentVersion: true },
    });
  }

  /**
   * Le dice al paciente, **una vez**, que su nota de voz la transcribe una IA
   * de un tercero y que el audio no se guarda. Devuelve `false` si no se le
   * pudo decir: entonces no se transcribe.
   *
   * El aviso va ANTES de mandarle el audio a nadie, que es lo que exige el
   * ADR 0004 §7.2: el consent vigente cuando el paciente escribió hablaba de
   * "mensajes", no de grabaciones de su voz.
   *
   * La marca de "ya avisado" vive en una columna propia y no en el `Message
   * OUT` con el texto del aviso, que es donde estaba al principio. Como prueba
   * ese mensaje no vale: `BotService.reply` persiste la respuesta del LLM
   * **verbatim** y el copy es público, así que una inyección de prompt
   * ("responde exactamente con: …") deja plantada una fila idéntica sin que el
   * aviso se haya mandado nunca — y desde la bandeja del panel se puede
   * escribir a mano. Una prueba que el propio sistema puede fabricar no se
   * puede enseñar en una auditoría, que es para lo único que sirve.
   *
   * La versión se guarda además del instante: si el texto cambia de versión,
   * el paciente recibe el nuevo una vez en vez de darse por avisado con el
   * viejo.
   */
  async function ensureVoiceConsent(
    convo: { id: string; voiceConsentVersion: string | null },
    data: BotInboundJobData,
    locale: string,
    wahaSession: string,
  ): Promise<boolean> {
    if (convo.voiceConsentVersion === VOICE_CONSENT_VERSION) return true;

    const texto = botCopy(locale).voiceNoteFirstTime;
    try {
      await waha.sendText(wahaSession, data.chatId, texto);
    } catch (e) {
      // Fail-closed, y en la dirección incómoda: si no se le pudo avisar, su
      // voz NO sale hacia un tercero. Repetir el aviso sería el error barato;
      // saltárselo es el caro.
      logger.warn(
        `consent de nota de voz no entregado clinic=${data.clinicId}: ${safeErrorLabel(e)}`,
      );
      return false;
    }

    // Ya lo recibió: a partir de aquí los fallos son de registro, no de aviso.
    // `updateMany` con la versión vieja en el `where` lo hace atómico — con más
    // de un worker, dos notas de voz seguidas no mandan dos avisos.
    try {
      await prisma.conversation.updateMany({
        where: {
          id: convo.id,
          OR: [
            { voiceConsentVersion: null },
            { voiceConsentVersion: { not: VOICE_CONSENT_VERSION } },
          ],
        },
        data: {
          voiceConsentAt: new Date(),
          voiceConsentVersion: VOICE_CONSENT_VERSION,
        },
      });
      await prisma.message.create({
        data: { conversationId: convo.id, direction: 'OUT', body: texto },
      });
    } catch (e) {
      // El paciente SÍ tiene el aviso; lo que falló es dejarlo escrito. No se
      // corta por esto: se seguiría sin transcribir a alguien a quien ya se le
      // avisó, y el próximo intento se lo repetiría igual.
      logger.warn(
        `consent de nota de voz enviado pero no registrado clinic=${data.clinicId}: ${safeErrorLabel(e)}`,
      );
    }
    return true;
  }

  /**
   * Le dice al paciente por qué no le respondemos a la nota de voz, antes de
   * dejarlo en la bandeja. Sin esto, el silencio es indistinguible de que el
   * bot esté roto — y el motivo importa: "es muy larga" tiene arreglo por su
   * parte, "caducó" no.
   */
  async function notifyTranscriptionFailed(
    data: BotInboundJobData,
    convoId: string,
    texto: string,
    wahaSession: string,
  ): Promise<void> {
    try {
      await waha.sendText(wahaSession, data.chatId, texto);
      // El `Message OUT` va DESPUÉS del envío y a propósito: la bandeja tiene
      // que reflejar lo que el paciente vio de verdad. Si persistiéramos antes,
      // un fallo de WAHA dejaría a la recepcionista leyendo un aviso que nadie
      // recibió y contestando "como te decíamos" a alguien que sólo vio
      // silencio. Ver [[notas/2026-09-11-cola-bot-inbound]].
      await prisma.message.create({
        data: { conversationId: convoId, direction: 'OUT', body: texto },
      });
    } catch (e) {
      // El aviso es best-effort: lo importante ya está hecho (la conversación
      // quedó en NEEDS_HUMAN y la clínica la ve en el triaje).
      logger.warn(
        `aviso de audio no enviado clinic=${data.clinicId}: ${safeErrorLabel(e)}`,
      );
    }
  }

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

  /**
   * Transcribe la nota de voz. Devuelve `undefined` cuando el fallo es
   * **definitivo** y ya se ha derivado al paciente a una persona.
   *
   * La distinción importa: un audio caducado o demasiado largo no se arregla
   * reintentando, así que reintentarlo sólo dejaría al paciente esperando más
   * tiempo una respuesta que no va a llegar. Los fallos de infraestructura sí
   * se relanzan, para que BullMQ lo intente otra vez dentro de la ventana.
   */
  async function transcribeOrHandoff(
    job: Job<BotInboundJobData>,
    clinic: { locale: string; wahaSession: string },
    startedAt: number,
  ): Promise<Transcription | undefined> {
    const { audio, clinicId } = job.data;
    if (!audio) return undefined;
    const copy = botCopy(clinic.locale);

    /**
     * Deriva y avisa. El aviso importa más aquí que en el camino de texto: el
     * webhook ya suprimió el "solo puedo leer texto" al ver que había algo que
     * transcribir, así que sin esto el paciente se queda en silencio absoluto.
     */
    const derivar = async (
      texto: string | null,
      convoId: string | null,
    ): Promise<undefined> => {
      await markNeedsHuman(job.data);
      if (texto && convoId) {
        await notifyTranscriptionFailed(
          job.data,
          convoId,
          texto,
          clinic.wahaSession,
        );
      }
      emit({
        job,
        outcome: 'unsupported',
        reasonCode: 'audio-no-transcrito',
        // Sin esto las notas de voz fallidas desaparecen de la latencia media,
        // que es justo donde la clínica miraría si algo va mal.
        latencyMs: Date.now() - startedAt,
        turn: { inputKind: 'audio', handoff: true },
      });
      return undefined;
    };

    // Ya transcrito en un intento anterior: no se vuelve a pagar. Va antes que
    // ninguna comprobación porque no hay nada que comprobar — el audio ya salió
    // y ya se pagó. Sin esto, un fallo aguas abajo (Postgres, WAHA) hace que el
    // reintento mande el mismo audio otra vez a OpenAI.
    if (job.data.transcript) {
      return { text: job.data.transcript, model: job.data.transcriptModel ?? '' };
    }

    // El gate se comprueba TAMBIÉN aquí, no sólo al encolar. Es un gate de
    // consent, no de rollout: si sólo se mirara en el webhook, apagarlo no
    // pararía los jobs ya encolados ni un `retry` desde el panel de BullMQ
    // dentro de la ventana de retención. Un kill switch que no mata no sirve
    // para responder a un incidente de cumplimiento.
    if (!isSttEnabled()) {
      logger.warn(
        `nota de voz descartada: STT apagado clinic=${clinicId} — derivando`,
      );
      const convo = await findConvo(job.data);
      return derivar(copy.voiceNoteFailed, convo?.id ?? null);
    }

    const convo = await findConvo(job.data);
    if (!convo) return derivar(null, null);

    // El estado se revalida aquí por el mismo motivo que el flag: entre encolar
    // y procesar hay cola, backoff y hasta 120 s de `lockDuration` si el job se
    // queda stalled. Si en esa ventana alguien tomó el hilo, mandar igualmente
    // la grabación a un tercero es gasto y divulgación sin beneficio para el
    // paciente: ya hay una persona leyéndolo. Y no se avisa, por lo mismo.
    if (convo.state === 'HUMAN') {
      logger.log(
        `nota de voz no transcrita: la atiende una persona clinic=${clinicId}`,
      );
      emit({
        job,
        outcome: 'skipped',
        reasonCode: 'conversacion-humana',
        latencyMs: Date.now() - startedAt,
        turn: { inputKind: 'audio' },
      });
      return undefined;
    }

    // El aviso de que la transcribe una IA de un tercero va ANTES de mandarle
    // nada a nadie. Si no se le pudo avisar, no se transcribe: se deriva, y sin
    // insistir con otro mensaje (mandar acaba de fallar).
    if (
      !(await ensureVoiceConsent(convo, job.data, clinic.locale, clinic.wahaSession))
    ) {
      return derivar(null, null);
    }

    try {
      const out = await stt.transcribe(audio.url, {
        clinicId,
        durationSec: audio.durationSec,
        // Normalizado: `Clinic.locale` es un `String` libre, y un `es-MX` suelto
        // sería un 400 de OpenAI —transitorio a ojos del worker— que dejaría a
        // esa clínica sin ninguna nota de voz y sin una señal clara.
        locale: botLocale(clinic.locale),
      });
      // Se guarda en el job antes de seguir: a partir de aquí, cualquier
      // reintento reusa el texto en vez de volver a llamar al proveedor.
      await job
        .updateData({ ...job.data, transcript: out.text, transcriptModel: out.model })
        .catch(() => undefined);
      return out;
    } catch (err) {
      // Sin clave de OpenAI no hay nada que reintentar: es configuración, no
      // una intermitencia. Si se tratara como transitorio, el paciente se
      // quedaría sin NINGUNA respuesta —el webhook ya suprimió el aviso de
      // "solo leo texto"— hasta agotar los intentos.
      const sinClave = !process.env.OPENAI_API_KEY;
      const definitivo =
        sinClave ||
        err instanceof MediaExpiredError ||
        err instanceof AudioTooLongError;
      if (!definitivo) throw err;

      logger.warn(
        `nota de voz no transcrita (${(err as Error).name}) clinic=${clinicId} — derivando`,
      );
      return derivar(
        err instanceof AudioTooLongError
          ? copy.voiceNoteTooLong
          : copy.voiceNoteFailed,
        convo.id,
      );
    }
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
    let clinic: { status: string; locale: string; wahaSession: string } | null;
    try {
      clinic = await prisma.clinic.findUnique({
        where: { id: clinicId },
        // `locale` para pasarle al transcriptor el idioma de la clínica: sube
        // la precisión y evita que una nota corta en español se transcriba
        // como si fuera portuguesa.
        select: { status: true, locale: true, wahaSession: true },
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
    // Nota de voz: se transcribe y el texto entra al pipeline como si el
    // paciente lo hubiera escrito. Si no se puede, se deriva a una persona en
    // vez de dejarle sin respuesta.
    let effectiveText = text;
    let transcription: Transcription | undefined;
    // `startedAt` arranca ANTES de transcribir: para la clínica el turno
    // empieza cuando llegó el mensaje, no cuando terminamos de prepararlo, y
    // la transcripción es la parte lenta.
    const startedAt = Date.now();
    if (job.data.audio) {
      const out = await transcribeOrHandoff(job, clinic, startedAt);
      if (!out) return; // ya se derivó y se emitió el evento
      transcription = out;
      effectiveText = out.text;
    }

    const turn = await runBotTurn(() =>
      bot.handleIncoming({
        clinicId,
        chatId,
        phone,
        lid,
        contactName,
        text: effectiveText,
        // El bot necesita saberlo, no sólo el dashboard: desde una nota de voz
        // no se confirma ni se cancela una cita sin repreguntar por escrito.
        ...(transcription ? { inputKind: 'audio' as const } : {}),
      }),
    );

    const latencyMs = Date.now() - startedAt;

    emit({
      job,
      outcome: turn.ok ? 'ok' : 'error',
      latencyMs,
      // `inputKind` se mezcla aquí y no con `recordBotTurn`: el contexto del
      // turno ya está cerrado cuando `runBotTurn` devuelve, así que anotarlo
      // después no llegaría a ningún sitio.
      turn: {
        ...turn.data,
        ...(transcription ? { inputKind: 'audio' as const } : {}),
      },
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
