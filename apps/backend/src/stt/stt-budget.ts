import type { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { hashChatId } from '../bot/bot-rate-limit';

/**
 * Cota diaria de transcripciones (S38).
 *
 * Por qué hace falta teniendo ya el rate-limit del ADR 0007: ese es
 * **fail-open** a propósito —con Redis caído deja pasar todo, porque el coste
 * de bloquear a un paciente es peor que el de una llamada de más al LLM— y su
 * techo de 500 mensajes/h por clínica son unas 12.000 transcripciones al día.
 * Con texto eso significaba "más llamadas al LLM"; con audio significa gasto
 * por minuto y grabaciones de pacientes saliendo del perímetro.
 *
 * Dos cotas, no una:
 *
 * - **por clínica**, que es el tope de gasto;
 * - **por chat**, porque sin ella un solo número agota la cota de la clínica en
 *   unos 14 minutos (el ADR 0007 le deja 15 mensajes/min). Eso serían dos
 *   cosas a la vez: la clínica paga las transcripciones del atacante, y sus
 *   pacientes reales se quedan sin el feature el resto del día.
 */

/** Suficiente para el piloto y barato de subir; ver README. */
export const STT_DAILY_LIMIT_DEFAULT = 200;

/**
 * Tope por conversación. Un paciente real no manda 20 notas de voz en un día;
 * quien lo haga no necesita que se las transcribamos todas.
 */
export const STT_DAILY_LIMIT_PER_CHAT = 20;

const QUOTA_TTL_S = 48 * 60 * 60;

/** Qué dijo la cota. `indeterminado` NO es `agotado`: ver `withinSttBudget`. */
export type SttBudgetStatus = 'ok' | 'agotado' | 'indeterminado';

function parseLimit(raw: string | undefined, fallback: number, logger?: Logger): number {
  if (raw === undefined || raw === '') return fallback;
  // `Number()` aceptaría `'0x10'` (16), `'1e3'` (1000) y `' 10 '`: una errata
  // en Coolify subiría el tope en vez de avisar. Solo dígitos.
  if (!/^\d+$/.test(raw.trim())) {
    logger?.warn(`STT_DAILY_LIMIT inválido (${raw}): uso el default ${fallback}`);
    return fallback;
  }
  return Number(raw.trim());
}

/**
 * Límite por clínica y día. Un valor inválido NO se ignora en silencio ni se
 * convierte en cero: un `STT_DAILY_LIMIT=doscientos` leído como 0 apagaría la
 * transcripción de todo el mundo y parecería un bug del feature, no una errata
 * de configuración. Un `0` explícito sí apaga, porque eso sí es una decisión.
 */
export function sttDailyLimit(logger?: Logger): number {
  return parseLimit(process.env.STT_DAILY_LIMIT, STT_DAILY_LIMIT_DEFAULT, logger);
}

/**
 * Día **UTC**, y esto es un cambio de opinión que merece explicación.
 *
 * La primera versión usaba la TZ de la clínica, siguiendo la regla de CLAUDE.md
 * ("fechas siempre con la zona de la clínica"). Dos motivos para no hacerlo
 * aquí:
 *
 * 1. Esa regla es para fechas **que alguien lee**. Esto es un contador de
 *    gasto: nadie lo mira, y la clínica no ve la diferencia.
 * 2. La TZ la edita el propio tenant (`PATCH /api/clinics/me`). Con la fecha
 *    local dentro de la clave, rotar la zona genera claves nuevas y **triplica
 *    la cota**: un control de gasto que el controlado puede reiniciar no es un
 *    control.
 *
 * De regalo desaparece el otro problema: `Clinic.timezone` es un `String`
 * libre y una zona inválida hacía que Luxon devolviera la cadena
 * `"Invalid DateTime"`, dejando una clave que **no rota nunca** — esa clínica
 * pasaba de 200 al día a 200 cada 48 h, sin ninguna señal.
 */
export function utcDay(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * `clinicId` saneado igual que en `botStatsKey`: hoy es un cuid, pero es lo que
 * separa a un tenant de otro dentro de la clave. El chat va **hasheado**
 * (HMAC con `LOG_HASH_SECRET` y el `clinicId` en la preimagen): un teléfono en
 * claro dentro de una clave de Redis es PII, y ya hay deuda de eso en
 * `bot:media-notice:`; no añadimos más.
 */
export function sttQuotaKeys(
  clinicId: string,
  chatId: string,
  nowMs: number = Date.now(),
): { clinicKey: string; chatKey: string } {
  const safeClinic = clinicId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const dia = utcDay(nowMs);
  return {
    clinicKey: `stt:quota:${safeClinic}:${dia}`,
    chatKey: `stt:quota-chat:${safeClinic}:${hashChatId(chatId, clinicId)}:${dia}`,
  };
}

/**
 * ¿Parece que hay presupuesto? **Solo lee**, y es un filtro barato: sirve para
 * decidir ya si al paciente se le manda el aviso de "solo leo texto" o se le
 * encola la nota de voz. Quien de verdad manda es `claimSttBudget`, en el
 * worker, justo antes de pagar.
 *
 * Devuelve tres estados y no un booleano porque `agotado` e `indeterminado`
 * piden cosas distintas aguas arriba: con `agotado` el paciente entra en el
 * camino normal (con su throttle de 6 h); con `indeterminado` —Redis mudo— hay
 * que forzarle el aviso, porque si no se queda sin transcripción **y** sin
 * respuesta, que es peor que antes de M10.
 */
export async function withinSttBudget(
  redis: Redis,
  logger: Logger,
  params: { clinicId: string; chatId: string },
): Promise<SttBudgetStatus> {
  const limite = sttDailyLimit(logger);
  if (limite === 0) return 'agotado';
  const { clinicKey, chatKey } = sttQuotaKeys(params.clinicId, params.chatId);
  try {
    const [clinica, chat] = await redis.mget(clinicKey, chatKey);
    if (Number(clinica ?? 0) >= limite) return 'agotado';
    if (Number(chat ?? 0) >= STT_DAILY_LIMIT_PER_CHAT) return 'agotado';
    return 'ok';
  } catch (e) {
    logger.warn(
      `presupuesto de STT no consultable (redis) clinic=${params.clinicId}: ${(e as Error).message}`,
    );
    return 'indeterminado';
  }
}

/**
 * Reserva una transcripción. `false` = no transcribas.
 *
 * **Comprueba y apunta en el mismo comando**, que es lo que lo convierte en un
 * tope de verdad. La versión anterior leía con `GET` y apuntaba aparte
 * tragándose los errores: con un Redis que acepta lecturas y rechaza escrituras
 * —disco lleno con `stop-writes-on-bgsave-error yes`, que es el default— el
 * contador se congelaba y la cota quedaba **desactivada en silencio**, gastando
 * dinero. Justo el fallo que esto existe para impedir.
 *
 * Va en el worker y no en el webhook por el mismo motivo que el gate de
 * `STT_ENABLED` se recomprueba allí: bajar el límite durante un incidente de
 * coste tiene que parar también los jobs ya encolados y los `retry` desde el
 * panel de BullMQ. Y porque el dinero se gasta en `stt.transcribe`, no al
 * encolar: contar antes cobraba por todo lo que aborta en medio (consent no
 * enviable, audio caducado, sin clave de OpenAI).
 *
 * El chat se comprueba ANTES que la clínica, y a propósito: si se incrementara
 * la de la clínica primero, quien haya agotado su cota de chat seguiría
 * quemando la de todos.
 */
export async function claimSttBudget(
  redis: Redis,
  logger: Logger,
  params: { clinicId: string; chatId: string },
): Promise<boolean> {
  const limite = sttDailyLimit(logger);
  if (limite === 0) return false;
  const { clinicKey, chatKey } = sttQuotaKeys(params.clinicId, params.chatId);

  const chat = await incrConTtl(redis, logger, chatKey, params.clinicId);
  if (chat === null) return false;
  if (chat > STT_DAILY_LIMIT_PER_CHAT) {
    logger.warn(
      `nota de voz sin transcribir: cota del chat agotada clinic=${params.clinicId}`,
    );
    return false;
  }

  const clinica = await incrConTtl(redis, logger, clinicKey, params.clinicId);
  if (clinica === null) return false;
  return clinica <= limite;
}

/** `INCR` + `EXPIRE NX`. `null` si no se pudo contar (y entonces no se gasta). */
async function incrConTtl(
  redis: Redis,
  logger: Logger,
  key: string,
  clinicId: string,
): Promise<number | null> {
  try {
    const pipe = redis.pipeline();
    pipe.incr(key);
    // `NX`: el TTL se fija al crear la clave. Renovarlo en cada nota de voz
    // haría que una clínica activa arrastrara el contador de ayer.
    pipe.expire(key, QUOTA_TTL_S, 'NX');
    const results = await pipe.exec();

    // `exec()` NO rechaza por errores de comandos sueltos: los devuelve dentro
    // del array. Sin mirarlos, un `MISCONF` dejaría el contador clavado y la
    // cota dejaría de contar sin que nadie se entere.
    const [incrErr, valor] = results?.[0] ?? [new Error('sin respuesta'), null];
    if (incrErr || typeof valor !== 'number') {
      logger.error(
        `presupuesto de STT no reservable clinic=${clinicId}: ${
          (incrErr as Error)?.message ?? 'respuesta inesperada'
        }`,
      );
      return null;
    }
    const ttlErr = results?.[1]?.[0];
    if (ttlErr) {
      logger.warn(
        `TTL de la cota de STT no fijado clinic=${clinicId}: ${(ttlErr as Error).message}`,
      );
    }
    return valor;
  } catch (e) {
    logger.error(
      `presupuesto de STT no reservable (redis) clinic=${clinicId}: ${(e as Error).message}`,
    );
    return null;
  }
}
