import { PassThrough } from 'node:stream';
import pino from 'pino';
import { PII_REDACT_OPTIONS } from '../pii-redactor';

/**
 * Arnés para comprobar que un evento estructurado **sobrevive al redactor de
 * PII real** antes de llegar al destino de logs.
 *
 * Por qué existe: `nestjs-pino` vuelca el objeto del log en la **raíz** del
 * entry, así que cualquier clave del evento que coincida con un path de
 * `PII_REDACT_PATHS` sale como `[REDACTED]` en producción. Y no lo detecta
 * ningún test normal, porque los tests espían `Logger.prototype.log` de Nest,
 * que corre **antes** de que pino redacte: verde en CI, ciego en el destino.
 *
 * Ya pasó una vez, con el evento `bot.turn`: su campo se llamaba `reason`, que
 * está en la lista por el motivo de consulta del paciente. Salía redactado en
 * producción y ningún test lo veía.
 *
 * La regla que esto hace cumplir: **todo evento estructurado nuevo pasa por
 * aquí**. Cuesta una línea y cierra una clase entera de bug silencioso.
 */
export function createRedactingLogger(): {
  log: pino.Logger;
  readLast: () => Record<string, unknown>;
} {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

  const log = pino({ redact: PII_REDACT_OPTIONS, level: 'info' }, stream);

  return {
    log,
    readLast: () => {
      const raw = chunks.join('').trim().split('\n').pop() ?? '{}';
      return JSON.parse(raw) as Record<string, unknown>;
    },
  };
}

/** Compara en profundidad y devuelve el path del primer campo que no coincide. */
function firstMismatch(
  expected: unknown,
  actual: unknown,
  path: string,
): string | null {
  if (
    expected !== null &&
    typeof expected === 'object' &&
    !Array.isArray(expected)
  ) {
    if (actual === null || typeof actual !== 'object') return path;
    for (const [key, value] of Object.entries(
      expected as Record<string, unknown>,
    )) {
      const found = firstMismatch(
        value,
        (actual as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
      );
      if (found) return found;
    }
    return null;
  }
  return JSON.stringify(expected) === JSON.stringify(actual) ? null : path;
}

/**
 * Afirma que el evento llega entero al log, sin ningún campo censurado.
 *
 * Se le pasa un ejemplar **con todos los campos rellenos**, incluidos los
 * opcionales: lo que no se pasa no se comprueba, y el campo que alguien añada
 * mañana es justo el que va a colisionar.
 */
export function expectEventSurvivesRedaction(
  event: Record<string, unknown>,
): void {
  const { log, readLast } = createRedactingLogger();
  log.info(event, 'evento de prueba');
  const entry = readLast();

  const bad = firstMismatch(event, entry, '');
  if (bad) {
    throw new Error(
      `El campo "${bad}" del evento no sobrevive al redactor de PII: ` +
        `coincide con un path de PII_REDACT_PATHS y en producción sale como ` +
        `"[REDACTED]". Renómbralo (p. ej. \`reason\` → \`reasonCode\`).\n\n` +
        `Y antes de renombrarlo, mira QUÉ valor llevaba: si el campo está en ` +
        `esa lista es porque ahí suele haber PII, así que la redacción podía ` +
        `estar tapando una fuga. Renombrar sin mirar la convierte en real.\n\n` +
        `Esperado: ${JSON.stringify(event)}\nRecibido: ${JSON.stringify(entry)}`,
    );
  }
}
