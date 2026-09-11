import {
  isAmbiguousYes,
  isBareGreeting,
  isCourtesyClosing,
  isHumanEscape,
  normalizeText,
  parseReminderReply,
  stripGreeting,
} from './message-matching';

describe('message-matching', () => {
  describe('stripGreeting (B1)', () => {
    const clinic = 'Clínica Dental Sonrisa';

    it.each([
      ['hola', ''],
      ['Hola!', ''],
      ['hola que tal', ''],
      ['Buenos días', ''],
      ['buenas tardes, cómo estás', ''],
      ['hola, quiero agendar una cita', 'quiero agendar una cita'],
      ['Buenas! cuánto cuesta la limpieza?', 'cuánto cuesta la limpieza?'],
      ['Hola Clínica Dental Sonrisa, dónde quedan?', 'dónde quedan?'],
      ['holaaa buenas noches necesito un turno', 'necesito un turno'],
    ])('"%s" → resto "%s"', (text, expected) => {
      const { matched, rest } = stripGreeting(text, clinic);
      expect(matched).toBe(true);
      expect(rest).toBe(expected);
    });

    it('sin saludo no recorta nada', () => {
      const { matched, rest } = stripGreeting('necesito un turno', clinic);
      expect(matched).toBe(false);
      expect(rest).toBe('necesito un turno');
    });

    it('conserva tildes y mayúsculas del resto (va al RAG tal cual)', () => {
      expect(stripGreeting('Hola, ¿atienden los sábados?', clinic).rest).toBe(
        '¿atienden los sábados?',
      );
    });

    it('no recorta cuando el saludo viene pegado a la palabra siguiente', () => {
      // "hola,quiero" normaliza a dos palabras: preferimos no recortar de más.
      expect(stripGreeting('hola,quiero agendar', clinic).matched).toBe(false);
    });
  });

  describe('isBareGreeting (B1)', () => {
    it('vacío o muletilla corta → saludo', () => {
      expect(isBareGreeting('')).toBe(true);
      expect(isBareGreeting('todo bien')).toBe(true);
      expect(isBareGreeting('y ustedes')).toBe(true);
    });

    // El fraseo corto es el habitual en WhatsApp y era justo el bug B1.
    it.each([
      'quiero agendar',
      'necesito cita',
      'cuanto cuesta',
      'horarios',
      'atienden hoy',
      'precios',
      'quiero agendar una cita',
    ])('"%s" NO es saludo: es contenido', (rest) => {
      expect(isBareGreeting(rest)).toBe(false);
    });
  });

  describe('isCourtesyClosing (B2)', () => {
    it.each(['gracias', 'muchas gracias', 'ok gracias', 'listo gracias', 'mil gracias', 'gracias por todo'])(
      '"%s" es cierre',
      (text) => expect(isCourtesyClosing(normalizeText(text))).toBe(true),
    );

    it.each(['gracias, quiero agendar', 'gracias pero necesito cambiar la fecha', ''])(
      '"%s" NO es cierre',
      (text) => expect(isCourtesyClosing(normalizeText(text))).toBe(false),
    );
  });

  describe('isHumanEscape (B3)', () => {
    it.each([
      'quiero hablar con una persona',
      'humano',
      'necesito que me atienda una persona',
      'quiero una persona real',
      'pásame con un asesor',
    ])('"%s" deriva', (text) => expect(isHumanEscape(normalizeText(text))).toBe(true));

    it.each([
      'es para otra persona',
      'soy la persona que llamó ayer',
      'la cita es para una persona mayor',
      '',
    ])('"%s" NO deriva', (text) =>
      expect(isHumanEscape(normalizeText(text))).toBe(false),
    );
  });

  describe('parseReminderReply / isAmbiguousYes (B2)', () => {
    it('separa los ambiguos de los verbos explícitos', () => {
      expect(parseReminderReply('si')).toBe('YES');
      expect(isAmbiguousYes('si')).toBe(true);
      expect(parseReminderReply('confirmo')).toBe('YES');
      expect(isAmbiguousYes('confirmo')).toBe(false);
      expect(parseReminderReply('cancelar')).toBe('CANCEL');
      expect(parseReminderReply('reagendar')).toBe('RESCHEDULE');
      expect(parseReminderReply('sin turno para hoy')).toBeNull();
    });
  });
});
