import { AsyncLocalStorage } from 'node:async_hooks';
import type { Intent } from './intent.service';

/**
 * Contexto de un turno del bot, para el evento `bot.turn` (M9).
 *
 * El problema que resuelve: quien **emite** el evento es el processor de
 * `bot-inbound` (y el webhook, para los adjuntos), porque es el único sitio
 * donde se sabe la latencia real del turno y donde se emite pase lo que pase,
 * también si el turno revienta. Pero los datos más valiosos —qué intención se
 * detectó, si la resolvió una regla o el LLM, cómo fue la búsqueda del RAG—
 * sólo se conocen **dentro** de `BotService`.
 *
 * En vez de que `BotService` loguee por su cuenta (un evento por turno
 * repartido en cinco sitios, imposible de correlacionar), va rellenando este
 * contexto y el processor emite UNA línea al final.
 *
 * Mismo mecanismo que `requestContext`: `AsyncLocalStorage` sobrevive a los
 * `await` sin tener que pasar un parámetro por toda la cadena de llamadas.
 *
 * **Nada de PII aquí.** Ni el texto del paciente, ni su teléfono, ni el
 * `chatId` en claro: lo que identifica la conversación es un hash corto, y lo
 * pone quien emite, no quien rellena.
 */
export interface BotTurnData {
  /**
   * Intención detectada. Tipada con el enum, no con `string`: el valor acaba
   * siendo el nombre de un campo de hash en Redis, y un valor libre haría
   * crecer la cardinalidad sin techo.
   */
  intent?: Intent;
  /** Quién la resolvió: el prefiltro determinista o el clasificador LLM. */
  source?: 'rule' | 'llm';
  /** El turno acabó derivando a una persona. */
  handoff?: boolean;
  /** Resultado de la búsqueda del RAG, si hubo. */
  rag?: {
    /** Chunks recuperados antes de filtrar por distancia. */
    candidates: number;
    /** Los que pasaron el umbral. */
    matches: number;
    /** Distancia del mejor match, o `null` si no hubo ninguno. */
    minDist: number | null;
    /** El LLM respondió `NULL_ANSWER` (no sabía, y lo dijo). */
    nullAnswer: boolean;
  };
}

const storage = new AsyncLocalStorage<BotTurnData>();

/**
 * Resultado de un turno. Unión **discriminada por `ok`**, no por si `error`
 * viene relleno: un `throw null` o un `throw ''` —que pasa más de lo que
 * parece con código transpilado y algunos SDK— haría que un `if (error)`
 * leyera el turno como exitoso, se emitiera `outcome: 'ok'` y el job se
 * marcara completado sin que el paciente recibiera nada.
 */
export type BotTurnResult<T> =
  | { ok: true; data: BotTurnData; result: T }
  | { ok: false; data: BotTurnData; error: unknown };

/**
 * Abre un turno y devuelve lo que se haya registrado durante él.
 *
 * Devuelve los datos **también si `fn` lanza**: un turno que falla es
 * justamente el que más interesa observar. Por eso el caller recibe el
 * contexto por separado y decide qué hacer con el error.
 */
export async function runBotTurn<T>(
  fn: () => Promise<T>,
): Promise<BotTurnResult<T>> {
  const data: BotTurnData = {};
  try {
    const result = await storage.run(data, fn);
    return { ok: true, data, result };
  } catch (error) {
    return { ok: false, data, error };
  }
}

/**
 * Anota datos del turno en curso. **No-op fuera de un turno**, a propósito:
 * `BotService` también corre desde tests y desde otros caminos, y no queremos
 * que tenga que preguntarse si hay contexto.
 */
export function recordBotTurn(patch: Partial<BotTurnData>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}

/** Sólo para tests: leer el contexto activo. */
export function currentBotTurn(): BotTurnData | undefined {
  return storage.getStore();
}
