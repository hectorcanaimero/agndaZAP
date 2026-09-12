import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { DateTime } from 'luxon';
import type { BotTurnEvent, BotTurnOutcome } from './bot-turn-event';

/**
 * Contadores agregados del bot, por clínica y día, en Redis.
 *
 * Por qué existen: el evento `bot.turn` va a los logs, y el dashboard de la
 * clínica no puede depender de consultar Axiom para pintar una tabla. Las
 * intenciones y la tasa de `NULL_ANSWER` no están en ninguna tabla de
 * Postgres, así que o se guardan aquí o habría que crear una tabla y su
 * migración para datos que caducan en un mes.
 *
 * Un hash por `(clínica, día)` con `HINCRBY`: escritura barata, y el
 * dashboard suma los días del rango que le pidan.
 *
 * Dos cosas que el consumidor tiene que saber para no restar mal:
 *
 * - **`turns` incluye los descartados** (`outcome:skipped`) y los adjuntos
 *   (`outcome:unsupported`), no sólo los que atendió el bot. "Turnos
 *   atendidos" es `outcome:ok`.
 * - **No hay latencia aquí.** Es una distribución, y un contador no la
 *   representa; para eso está el evento `bot.turn` en el destino de logs.
 */

/** 35 días: cubre la ventana de 30 del dashboard con margen. */
export const BOT_STATS_TTL_S = 35 * 86_400;

/**
 * El día va en la **zona de la clínica**, con Luxon, como manda el CLAUDE.md.
 *
 * Con corte UTC, en Caracas (UTC-4) todo lo que entra entre las 20:00 y la
 * medianoche caería en el bucket del día siguiente: el "hoy" del panel saldría
 * a cero justo en la franja de tarde-noche. Ninguno de los dos emisores paga
 * una query extra por esto — los dos ya consultan la clínica.
 *
 * `clinicId` se acota igual que los nombres de campo: hoy es un cuid, pero es
 * lo que separa a un tenant de otro dentro de la clave.
 */
export function botStatsKey(
  clinicId: string,
  timezone: string,
  now: DateTime = DateTime.now(),
): string {
  const safeClinic = clinicId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `bot:stats:${safeClinic}:${now.setZone(timezone).toISODate()}`;
}

/**
 * Campos de hash con nombre derivado de un valor: se acotan a `[a-z0-9_]` y a
 * 40 caracteres. Hoy `intent` sale de un enum, pero es un valor que viaja
 * desde el clasificador y no quiero que un día una respuesta rara del LLM
 * escriba campos arbitrarios en Redis.
 */
function safeField(prefix: string, value: string): string | null {
  const clean = value.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!clean) return null;
  return `${prefix}:${clean.slice(0, 40)}`;
}

/**
 * Suma un turno a los contadores del día.
 *
 * **Fail-open y sin `await` bloqueante en el caller**: perder una métrica no
 * puede costar la respuesta a un paciente.
 */
export async function recordBotStats(
  redis: Redis,
  logger: Logger,
  event: BotTurnEvent,
  timezone: string,
): Promise<void> {
  try {
    const key = botStatsKey(event.clinicId, timezone);
    const fields: string[] = ['turns', '1'];

    const outcome = safeField('outcome', event.outcome);
    if (outcome) fields.push(outcome, '1');
    if (event.intent) {
      const f = safeField('intent', event.intent);
      if (f) fields.push(f, '1');
    }
    if (event.source) {
      const f = safeField('source', event.source);
      if (f) fields.push(f, '1');
    }
    if (event.handoff) fields.push('handoff', '1');
    // Sólo el audio: el texto es el caso normal y `turns` ya lo cuenta.
    if (event.inputKind === 'audio') fields.push('audio', '1');
    if (event.rag) {
      fields.push('rag', '1');
      if (event.rag.nullAnswer) fields.push('nullAnswer', '1');
      if (event.rag.matches > 0) fields.push('ragMatched', '1');
    }

    // `HINCRBY` campo a campo en un pipeline: una sola ida y vuelta.
    const pipe = redis.pipeline();
    for (let i = 0; i < fields.length; i += 2) {
      pipe.hincrby(key, fields[i], Number(fields[i + 1]));
    }
    // `NX`: el TTL se fija una vez, al crear la clave. Renovarlo en cada turno
    // haría que la retención real dependiera del último mensaje del día —
    // hasta 36 días en vez de 35— y la política de retención de datos tiene
    // que poder afirmarse, no estimarse.
    pipe.expire(key, BOT_STATS_TTL_S, 'NX');
    const results = await pipe.exec();

    // Un pipeline de ioredis NO es atómico y `exec()` no rechaza por errores
    // de comandos sueltos: los devuelve dentro del array. Sin mirarlos, una
    // clave con el tipo equivocado (un `bot:stats:*` creado a mano en una
    // sesión de debug) haría fallar todos los HINCRBY en silencio y el
    // dashboard mostraría ceros para siempre.
    const failed = (results ?? []).filter(([err]) => err);
    if (failed.length) {
      logger.warn(
        `contadores del bot: ${failed.length} comandos fallaron clinic=${event.clinicId}: ${
          (failed[0][0] as Error)?.message ?? 'desconocido'
        }`,
      );
    }
  } catch (e) {
    logger.warn(
      `contadores del bot fallaron (redis) clinic=${event.clinicId}: ${(e as Error).message}`,
    );
  }
}

/**
 * Lo que el dashboard necesita saber de un periodo.
 *
 * Los campos que pueden no estar cableados todavía son `number | null`, y el
 * `null` significa **"no se midió ni una vez en el periodo"**, no cero. Es la
 * distinción que sostiene todo el bloque del panel: un contador que nadie
 * escribe leído como 0 se pinta como "0% de derivaciones a una persona", o sea
 * exactamente la afirmación contraria a la verdad.
 */
export interface BotStatsWindow {
  /** Turnos contados, incluidos descartados y adjuntos. */
  turns: number;
  /** Desglose por desenlace: `ok`, `skipped`, `unsupported`, `error`. */
  outcomes: Partial<Record<BotTurnOutcome, number>>;
  /** Por intención. Vacío mientras el bot no cablee `recordBotTurn`. */
  intents: Record<string, number>;
  /** `null` = el bot todavía no anota derivaciones. */
  handoff: number | null;
  /** `null` = no hubo ni una consulta al RAG en el periodo. */
  rag: number | null;
  ragMatched: number | null;
  nullAnswer: number | null;
  /**
   * `false` cuando no hay ni un contador en el periodo. Sirve para distinguir
   * "la clínica no tuvo actividad" de "esto todavía no mide nada", que en un
   * panel se ven igual (ceros) y significan cosas opuestas.
   */
  hasData: boolean;
  /** Días cuya lectura falló. Si es > 0, los totales están incompletos. */
  readErrors: number;
}

/**
 * Suma los contadores de los últimos `days` días (incluido hoy) en la zona de
 * la clínica.
 *
 * Un `HGETALL` por día en un pipeline: con 30 días son 30 lecturas de hashes
 * pequeños en una sola ida y vuelta. No hay `KEYS` ni `SCAN` a propósito —
 * recorrer el espacio de claves de Redis desde una request del panel es la
 * forma clásica de convertir un dashboard en un incidente.
 */
export async function readBotStats(
  redis: Redis,
  clinicId: string,
  timezone: string,
  days: number,
  now: DateTime = DateTime.now(),
): Promise<BotStatsWindow> {
  const local = now.setZone(timezone);
  const pipe = redis.pipeline();
  for (let i = 0; i < days; i++) {
    pipe.hgetall(botStatsKey(clinicId, timezone, local.minus({ days: i })));
  }
  const results = await pipe.exec();

  const acc: BotStatsWindow = {
    turns: 0,
    outcomes: {},
    intents: {},
    handoff: null,
    rag: null,
    ragMatched: null,
    nullAnswer: null,
    hasData: false,
    readErrors: 0,
  };

  /** Suma en un campo que arranca en `null`: visto una vez, deja de ser null. */
  const bump = (key: 'handoff' | 'rag' | 'ragMatched' | 'nullAnswer', n: number) => {
    acc[key] = (acc[key] ?? 0) + n;
  };

  for (const [err, value] of results ?? []) {
    // El lado de escritura ya mira los errores por comando; el de lectura
    // tiene el mismo riesgo, y tragárselos haría que el panel mostrara un
    // total parcial como si fuera el real.
    if (err) {
      acc.readErrors += 1;
      continue;
    }
    if (!value) continue;
    for (const [field, raw] of Object.entries(value as Record<string, string>)) {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) continue;
      acc.hasData = true;
      if (field === 'turns') acc.turns += n;
      else if (field === 'handoff') bump('handoff', n);
      else if (field === 'rag') bump('rag', n);
      else if (field === 'ragMatched') bump('ragMatched', n);
      else if (field === 'nullAnswer') bump('nullAnswer', n);
      else if (field.startsWith('outcome:')) {
        const key = field.slice('outcome:'.length) as BotTurnOutcome;
        acc.outcomes[key] = (acc.outcomes[key] ?? 0) + n;
      } else if (field.startsWith('intent:')) {
        const key = field.slice('intent:'.length);
        acc.intents[key] = (acc.intents[key] ?? 0) + n;
      }
      // `source:*` se ignora a propósito: el panel no muestra si respondió una
      // regla o el LLM, es una métrica nuestra, no de la clínica.
    }
  }

  // `nullAnswer` sólo tiene sentido sobre consultas al RAG: si hubo RAG pero
  // ninguna acabó en "no lo sé", el cero es un dato real, no una ausencia.
  if (acc.rag !== null && acc.nullAnswer === null) acc.nullAnswer = 0;
  return acc;
}
