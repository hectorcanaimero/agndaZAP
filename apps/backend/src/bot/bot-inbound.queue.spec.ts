import {
  BOT_INBOUND_AUDIO_OPTS,
  BOT_INBOUND_JOB_OPTIONS,
  isSttEnabled,
} from './bot-inbound.queue';

/**
 * Opciones de la cola de entrantes. Son constantes, pero cada una está puesta
 * por un motivo que no se ve leyéndola, y cambiarla "para ir más rápido" rompe
 * algo en silencio. Estos tests dejan el motivo escrito.
 */
describe('opciones de la cola bot-inbound', () => {
  describe('prioridad', () => {
    /**
     * El gotcha de BullMQ: los jobs CON `priority` van a un ZSET aparte
     * (`prioritized`) y los que no la llevan a la lista `wait`, y
     * `moveToActive` vacía la lista ENTERA antes de mirar el ZSET. Un job
     * "prioritario" entre jobs sin prioridad se procesa el ÚLTIMO — justo al
     * revés de lo que dice la palabra.
     */
    it('los jobs de texto también llevan prioridad', () => {
      // Mayor que CERO, no "un número": en BullMQ `priority: 0` significa
      // exactamente "sin prioridad" y devuelve el job a la lista `wait`, que
      // es el bug de arriba otra vez.
      expect(BOT_INBOUND_JOB_OPTIONS.priority).toBeGreaterThan(0);
    });

    it('el audio adelanta al texto (en BullMQ, menor número = antes)', () => {
      expect(BOT_INBOUND_AUDIO_OPTS.priority).toBeLessThan(
        BOT_INBOUND_JOB_OPTIONS.priority,
      );
    });
  });

  describe('ventana del audio', () => {
    // WAHA borra el fichero a los 900 s (`WHATSAPP_FILES_LIFETIME`): un
    // backoff exponencial de 2 s → 4 s → 8 s llega tarde y se encuentra un 404.
    it('reintenta poco y con backoff fijo y corto', () => {
      expect(BOT_INBOUND_AUDIO_OPTS.attempts).toBeLessThan(
        BOT_INBOUND_JOB_OPTIONS.attempts,
      );
      expect(BOT_INBOUND_AUDIO_OPTS.backoff.type).toBe('fixed');
      expect(BOT_INBOUND_AUDIO_OPTS.backoff.delay).toBeLessThanOrEqual(5_000);
    });

    it('un audio fallido no se queda 24 h en Redis', () => {
      // El job lleva la URL del media del paciente: se retiene lo justo para
      // poder mirarlo, no un día entero.
      expect(BOT_INBOUND_AUDIO_OPTS.removeOnFail.age).toBeLessThan(
        BOT_INBOUND_JOB_OPTIONS.removeOnFail.age,
      );
    });
  });

  describe('isSttEnabled', () => {
    afterEach(() => delete process.env.STT_ENABLED);

    it('apagado si la variable no está', () => {
      expect(isSttEnabled()).toBe(false);
    });

    it('sólo el literal "true" lo enciende', () => {
      // Un gate de cumplimiento no se enciende con un "1" o un "yes" puestos
      // de memoria: o está exactamente como lo documenta el runbook, o no.
      for (const v of ['1', 'yes', 'TRUE', 'on', '']) {
        process.env.STT_ENABLED = v;
        expect(isSttEnabled()).toBe(false);
      }
      process.env.STT_ENABLED = 'true';
      expect(isSttEnabled()).toBe(true);
    });
  });
});
