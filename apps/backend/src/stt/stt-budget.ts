import type { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { DateTime } from 'luxon';

/**
 * Cota diaria de transcripciones por clínica (S38).
 *
 * Por qué hace falta una cota propia teniendo ya el rate-limit del ADR 0007:
 * ese es **fail-open** a propósito (con Redis caído se deja pasar todo, porque
 * el coste de bloquear al paciente es peor que el de una llamada de más). Con
 * texto eso significaba "más llamadas al LLM"; con audio significa gasto en un
 * proveedor que cobra por minuto y grabaciones de pacientes saliendo del
 * perímetro. El techo que dejaba el ADR 0007 —500 mensajes/h por clínica— son
 * ~12.000 transcripciones al día por clínica: no es un techo, es el cielo.
 *
 * Esta cota es lo contrario: **fail-closed**. Si no se puede contar, no se
 * transcribe. El paciente no se queda sin atención — cae al camino de siempre,
 * el aviso de "solo puedo leer mensajes de texto", que ya deriva a una persona
 * si insiste con audios.
 */

/** Suficiente para el piloto y barato de subir; ver README. */
export const STT_DAILY_LIMIT_DEFAULT = 200;

/**
 * Límite por clínica y día. Un valor inválido en el env NO se ignora en
 * silencio: se avisa y se usa el default, porque un `STT_DAILY_LIMIT=doscientos`
 * interpretado como `0` apagaría la transcripción para todo el mundo y parecería
 * un bug del feature, no una errata de configuración.
 */
export function sttDailyLimit(logger?: Logger): number {
  const raw = process.env.STT_DAILY_LIMIT;
  if (raw === undefined || raw === '') return STT_DAILY_LIMIT_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger?.warn(
      `STT_DAILY_LIMIT inválido (${raw}): uso el default ${STT_DAILY_LIMIT_DEFAULT}`,
    );
    return STT_DAILY_LIMIT_DEFAULT;
  }
  return parsed;
}

/**
 * Clave del día **en la zona de la clínica**, no en la del proceso.
 *
 * No es un detalle: el backend corre en UTC y una clínica en Caracas (UTC-4)
 * vería su cota reiniciarse a las 20:00 hora local, en plena tarde de consulta.
 * Misma regla que el resto del producto (ver CLAUDE.md): las fechas que alguien
 * lee son siempre Luxon con la TZ de la clínica.
 */
export function sttQuotaKey(clinicId: string, timezone: string): string {
  const dia = DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');
  return `stt:quota:${clinicId}:${dia}`;
}

/**
 * TTL de la clave. 48 h y no 24: la clave se crea a una hora cualquiera del día
 * local, así que con 24 h exactas moriría a media mañana del día siguiente
 * dejando un hueco raro si alguien la consulta. Es un contador, no un dato: que
 * sobreviva medio día de más no molesta a nadie y evita depender de cuadrar el
 * TTL con el cambio de día.
 */
const QUOTA_TTL_S = 48 * 60 * 60;

/**
 * ¿Queda presupuesto? **Solo lee**: el consumo se apunta con
 * `consumeSttBudget` cuando de verdad se manda a transcribir.
 *
 * Separar leer de apuntar es lo que evita cobrar por lo que no se transcribió:
 * entre esta comprobación y el encolado todavía puede aparecer un motivo para
 * no mandar el audio (la conversación la tomó una persona). La carrera que eso
 * abre —dos webhooks a la vez leyendo el mismo valor— puede pasarse del límite
 * por uno o dos en el peor caso, y eso da igual: esto es un tope de gasto, no
 * contabilidad.
 */
export async function withinSttBudget(
  redis: Redis,
  logger: Logger,
  params: { clinicId: string; timezone: string },
): Promise<boolean> {
  const limite = sttDailyLimit(logger);
  if (limite === 0) return false;
  try {
    const usado = await redis.get(sttQuotaKey(params.clinicId, params.timezone));
    return Number(usado ?? 0) < limite;
  } catch (e) {
    // Fail-CLOSED, al revés que el rate-limit del ADR 0007. Aquí el coste de
    // equivocarse se paga en dinero y en grabaciones de pacientes saliendo
    // hacia un tercero; allí se pagaba en un mensaje sin responder.
    logger.warn(
      `presupuesto de STT no consultable (redis) clinic=${params.clinicId}: ${(e as Error).message}`,
    );
    return false;
  }
}

/**
 * Apunta una transcripción. Best-effort: si falla, ya se decidió transcribir y
 * cortar aquí solo dejaría al paciente sin respuesta por un contador.
 */
export async function consumeSttBudget(
  redis: Redis,
  logger: Logger,
  params: { clinicId: string; timezone: string },
): Promise<void> {
  const key = sttQuotaKey(params.clinicId, params.timezone);
  try {
    const pipe = redis.pipeline();
    pipe.incr(key);
    // `NX`: el TTL se fija al crear la clave. Renovarlo en cada nota de voz
    // haría que una clínica activa arrastrara el contador de ayer.
    pipe.expire(key, QUOTA_TTL_S, 'NX');
    const results = await pipe.exec();

    // `exec()` no rechaza por errores de comandos sueltos: los devuelve dentro
    // del array. Sin mirarlos, una clave con el tipo equivocado dejaría el
    // contador clavado en cero y la cota no contaría nada, en silencio.
    const failed = (results ?? []).filter(([err]) => err);
    if (failed.length) {
      logger.warn(
        `presupuesto de STT no apuntado clinic=${params.clinicId}: ${
          (failed[0][0] as Error)?.message ?? 'desconocido'
        }`,
      );
    }
  } catch (e) {
    logger.warn(
      `presupuesto de STT no apuntado (redis) clinic=${params.clinicId}: ${(e as Error).message}`,
    );
  }
}
