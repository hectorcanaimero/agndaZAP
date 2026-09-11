import { Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import Redis from 'ioredis';

/**
 * Rate-limit del bot (ADR 0007), en un solo sitio.
 *
 * Dos capas sobre las MISMAS claves de Redis, así que el presupuesto es
 * compartido entre todos los caminos de entrada y cada mensaje se cuenta una
 * sola vez:
 *
 *  1. **Por conversación**: ventana fija de un minuto en `(clinicId, chatId)`.
 *     Al superarla se descarta el mensaje en silencio — no le respondemos al
 *     spammer, que sería amplificar el ataque quemando presupuesto de LLM.
 *  2. **Circuit breaker por clínica**: cap horario que protege el número de la
 *     clínica ante un ataque distribuido (muchos `from` distintos).
 *
 * Lo usan `BotService.handleIncoming` (mensajes de texto) y
 * `WebhookController` (adjuntos, que no pasan por el bot). Antes vivía
 * duplicado en los dos, con el riesgo clásico de que alguien tocara un límite
 * en un sitio y no en el otro.
 *
 * **Fail-open**: si Redis está caído devolvemos `true` y dejamos pasar. La cota
 * real la ponen los constraints de la DB y el resto de rate-limits; quedarse
 * sin bot por una caída de Redis es peor que el flood que esto evita.
 */

/** Mensajes por minuto y conversación. */
export const BOT_PER_CHAT_LIMIT = 15;

/** Mensajes por hora y clínica (circuit breaker global). */
export const BOT_PER_CLINIC_HOURLY_LIMIT = 500;

/** TTL de la ventana por minuto: 90 s da margen al reloj sin acumular claves. */
const CHAT_WINDOW_TTL_S = 90;

/** TTL de la ventana horaria: 65 min, mismo criterio. */
const CLINIC_WINDOW_TTL_S = 3900;

/**
 * Seudónimo del `chatId` para poder loguear sin filtrar el teléfono.
 *
 * **HMAC, no hash a secas, y con la clínica en el preimagen.** Un SHA-256 sin
 * secreto sobre un E.164 no protege nada: el espacio de teléfonos es
 * enumerable y se recorre entero en minutos, así que el "hash" es el teléfono
 * escrito de otra forma. El número de bits nunca fue el punto — el secreto sí.
 *
 * El `clinicId` va dentro del preimagen para que el mismo paciente produzca
 * seudónimos distintos en clínicas distintas. Sin eso, un filtro por
 * `chatHash` en el destino de logs correlaciona a una persona entre tenants,
 * que es justo el enlace que el aislamiento multi-tenant existe para impedir.
 *
 * Sin `LOG_HASH_SECRET` el HMAC usa clave vacía: el seudónimo deja de ser
 * seguro pero sigue siendo estable, así que dev y tests funcionan igual.
 * `validateProdEnv` la exige en producción.
 */
export function hashChatId(chatId: string, clinicId = ''): string {
  return createHmac('sha256', process.env.LOG_HASH_SECRET ?? '')
    .update(`${clinicId}:${chatId}`)
    .digest('hex')
    .slice(0, 12);
}

/** Claves de las dos ventanas. Exportadas para poder asertarlas en tests. */
export function botRateLimitKeys(
  clinicId: string,
  chatId: string,
  nowMs: number,
): { chatKey: string; clinicKey: string } {
  return {
    chatKey: `bot:msg:${clinicId}:${chatId}:${Math.floor(nowMs / 60000)}`,
    clinicKey: `bot:msg:${clinicId}:hour:${Math.floor(nowMs / 3600000)}`,
  };
}

/**
 * Consume una unidad del presupuesto y dice si el mensaje puede procesarse.
 *
 * `scope` solo etiqueta los logs (`bot` para texto, `media` para adjuntos):
 * no cambia las claves ni los límites, el presupuesto es el mismo.
 */
export async function withinBotRateLimit(
  redis: Redis,
  logger: Logger,
  input: { clinicId: string; chatId: string; scope: 'bot' | 'media' },
): Promise<boolean> {
  const { clinicId, chatId, scope } = input;
  try {
    const { chatKey, clinicKey } = botRateLimitKeys(clinicId, chatId, Date.now());

    const count = await redis.incr(chatKey);
    if (count === 1) await redis.expire(chatKey, CHAT_WINDOW_TTL_S);
    if (count > BOT_PER_CHAT_LIMIT) {
      logger.warn(
        `${scope} rate-limit clinic=${clinicId} chat=${hashChatId(chatId, clinicId)} count=${count}`,
      );
      return false;
    }

    const hourCount = await redis.incr(clinicKey);
    if (hourCount === 1) await redis.expire(clinicKey, CLINIC_WINDOW_TTL_S);
    if (hourCount > BOT_PER_CLINIC_HOURLY_LIMIT) {
      logger.error(
        `${scope} hourly cap clinic=${clinicId} count=${hourCount} — circuit OPEN`,
      );
      return false;
    }

    return true;
  } catch (e) {
    logger.error(
      `${scope} rate-limit falló (redis) clinic=${clinicId}: ${(e as Error).message}`,
    );
    return true; // fail-open
  }
}
