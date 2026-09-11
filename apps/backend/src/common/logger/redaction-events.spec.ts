import { BOT_TURN_EVENT } from '../../bot/bot-turn-event';
import { expectEventSurvivesRedaction } from './testing/redaction-harness';

/**
 * **Norma del repo (S28): todo evento estructurado pasa por aquí.**
 *
 * `nestjs-pino` vuelca el objeto del log en la raíz del entry, así que una
 * clave que coincida con `PII_REDACT_PATHS` sale como `[REDACTED]` en
 * producción. Ningún test normal lo ve: espían el logger de Nest, que corre
 * antes de que pino redacte. Verde en CI, ciego en el destino de logs.
 *
 * Pasó con `bot.turn`, cuyo campo se llamaba `reason` — que está en la lista
 * por el motivo de consulta del paciente. Se publicó redactado y nadie se
 * enteró hasta la auditoría.
 *
 * Los ejemplares van con **todos** los campos rellenos, incluidos los
 * opcionales: lo que no se pasa no se comprueba, y el campo que alguien añada
 * mañana es justo el que va a colisionar.
 */
describe('los eventos estructurados sobreviven al redactor de PII', () => {
  it('bot.turn, con todos sus campos', () => {
    expectEventSurvivesRedaction({
      event: BOT_TURN_EVENT,
      clinicId: 'clinic-A',
      chatHash: 'ab12cd34ef56',
      outcome: 'error',
      latencyMs: 1234,
      requestId: 'req-1',
      reasonCode: 'bot-error',
      attempt: 2,
      intent: 'agendar',
      source: 'llm',
      handoff: true,
      rag: { candidates: 5, matches: 2, minDist: 0.31, nullAnswer: false },
    });
  });

  it.each([
    ['waha.health.tick', { event: 'waha.health.tick', count: 3 }],
    [
      'waha.health.failed',
      {
        event: 'waha.health.failed',
        clinicId: 'clinic-A',
        session: 'clinic-a',
        status: 'FAILED',
      },
    ],
    [
      'waha.health.error',
      { event: 'waha.health.error', clinicId: 'clinic-A', error: 'ECONNREFUSED' },
    ],
    ['waha.start', { event: 'waha.start', clinicId: 'clinic-A' }],
    [
      'waha.start.failed',
      { event: 'waha.start.failed', clinicId: 'clinic-A', error: 'HTTP 502' },
    ],
    ['waha.logout', { event: 'waha.logout', clinicId: 'clinic-A' }],
    [
      'waha.logout.failed',
      { event: 'waha.logout.failed', clinicId: 'clinic-A', error: 'HTTP 502' },
    ],
  ])('%s', (_name, event) => {
    expectEventSurvivesRedaction(event);
  });

  /**
   * El arnés tiene que fallar cuando debe: si no, este fichero entero sería
   * una tranquilidad falsa. `name` está en `PII_REDACT_PATHS` (nombre del
   * paciente), así que un evento que lo use como campo es exactamente el error
   * que esto persigue.
   */
  it('detecta un campo que SÍ colisiona', () => {
    expect(() =>
      expectEventSurvivesRedaction({ event: 'inventado', name: 'algo' }),
    ).toThrow(/no sobrevive al redactor/);
  });

  it('el mensaje de fallo dice qué campo es y avisa de no renombrar a ciegas', () => {
    try {
      expectEventSurvivesRedaction({ event: 'inventado', reason: 'algo' });
      throw new Error('debería haber fallado');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('"reason"');
      // La mitad importante: renombrar sin mirar el valor convierte un bug en
      // una fuga, porque la redacción podía estar tapándola.
      expect(msg).toContain('tapando una fuga');
    }
  });

  it('detecta también un campo anidado', () => {
    expect(() =>
      expectEventSurvivesRedaction({
        event: 'inventado',
        datos: { phone: '+584141234567' },
      }),
    ).toThrow(/datos\.phone/);
  });
});
