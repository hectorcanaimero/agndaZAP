import { Logger } from '@nestjs/common';
import type { BotTurnData } from './bot-turn-context';

/** Nombre del evento. Es la clave por la que se filtra en el destino de logs. */
export const BOT_TURN_EVENT = 'bot.turn';

/** Cómo terminó el turno. */
export type BotTurnOutcome =
  /** El bot respondió (o decidió callarse a propósito). */
  | 'ok'
  /** El turno lanzó; BullMQ lo reintentará o lo descartará. */
  | 'error'
  /** Ni llegó al bot: mensaje sin texto, contestado por el webhook. */
  | 'unsupported'
  /** Descartado antes de procesar. El porqué va en `reasonCode`. */
  | 'skipped';

/**
 * Motivo, de un conjunto **cerrado**.
 *
 * No es texto libre a propósito: el mensaje de una excepción puede arrastrar
 * lo que escribió el paciente (los errores de `JSON.parse` incluyen un
 * fragmento de la entrada, y las respuestas del LLM pueden hacer eco del
 * texto). Para agrupar en un dashboard hace falta una etiqueta estable, no una
 * frase; y el detalle del error ya se loguea aparte, en una línea de texto que
 * sí está saneada.
 */
export type BotTurnReason =
  | 'rate-limit'
  | 'clinica-no-activa'
  | 'bot-error'
  | 'job-desconocido'
  /** Nota de voz que no se pudo transcribir: caducada o demasiado larga. */
  | 'audio-no-transcrito'
  /** Nota de voz de un hilo que ya lleva una persona: no se transcribe. */
  | 'conversacion-humana';

/**
 * Campos que el turno rellena desde dentro y que se copian al evento.
 *
 * La lista es la fuente de verdad de la copia (ver `buildBotTurn`): si alguien
 * añade un campo a `BotTurnData` y no lo añade aquí, TypeScript no se queja y
 * el campo no llega nunca al destino de logs. Con `satisfies` el compilador
 * obliga a que todas las claves existan en `BotTurnData`.
 */
export const TURN_KEYS = [
  'intent',
  'source',
  'handoff',
  'rag',
  'inputKind',
] as const satisfies ReadonlyArray<keyof BotTurnData>;

export interface BotTurnEvent extends Pick<BotTurnData, (typeof TURN_KEYS)[number]> {
  event: typeof BOT_TURN_EVENT;
  clinicId: string;
  /**
   * Seudónimo del chatId (HMAC con secreto y sal por clínica). NUNCA el
   * chatId, que lleva el teléfono del paciente.
   */
  chatHash: string;
  outcome: BotTurnOutcome;
  /**
   * Sólo cuando el turno llegó a correr. Se omite en `skipped` en vez de
   * mandar 0: un cero se promedia y hunde la latencia media de la clínica.
   */
  latencyMs?: number;
  /** Correlaciona con la request del webhook que originó el turno. */
  requestId?: string;
  reasonCode?: BotTurnReason;
  /** Intento de BullMQ, 1-based. Sólo se emite si hubo reintento. */
  attempt?: number;
}

/**
 * Emite el evento `bot.turn`: una línea estructurada por turno del bot.
 *
 * Una sola línea, y emitida por quien envuelve el turno (el processor de
 * `bot-inbound`, o el webhook para los caminos que no llegan al bot). Si cada
 * parte del bot logueara lo suyo, un turno saldría repartido en cinco líneas
 * sin forma de correlacionarlas, y ninguna diría cuánto tardó de verdad.
 *
 * **Contrato: aquí no entra PII.** Ni texto del paciente, ni teléfono, ni
 * `chatId` en claro, ni mensajes de excepción. El redactor de Pino es la red
 * de seguridad, no la primera línea de defensa.
 *
 * Ojo con los nombres de campo: `nestjs-pino` vuelca el objeto en la RAÍZ del
 * log entry, así que cualquier clave que coincida con `PII_REDACT_PATHS` sale
 * como `[REDACTED]`. Por eso el motivo se llama `reasonCode` y no `reason`.
 */
export function emitBotTurn(logger: Logger, event: BotTurnEvent): void {
  logger.log(event);
}

/**
 * Construye el evento. Separado de la emisión para poder asertarlo en tests
 * sin espiar el logger.
 */
export function buildBotTurn(input: {
  clinicId: string;
  chatHash: string;
  outcome: BotTurnOutcome;
  latencyMs?: number;
  requestId?: string;
  reasonCode?: BotTurnReason;
  attempt?: number;
  turn?: BotTurnData;
}): BotTurnEvent {
  const { turn, ...rest } = input;
  const event: BotTurnEvent = { event: BOT_TURN_EVENT, ...rest };

  // Sólo los campos que el turno llegó a rellenar: un `intent: undefined` en
  // el dashboard parece un dato ausente cuando en realidad el camino ni pasó
  // por ahí.
  for (const key of TURN_KEYS) {
    const value = turn?.[key];
    if (value === undefined) continue;
    if (key === 'rag') {
      // Copia, no referencia: `recordBotStats` lee esto en un microtask
      // posterior y una mutación tardía cambiaría lo contado.
      event.rag = { ...(value as NonNullable<BotTurnData['rag']>) };
    } else {
      Object.assign(event, { [key]: value });
    }
  }
  return event;
}
