import { normalizeE164, phoneToChatId } from './phone.util';

describe('normalizeE164', () => {
  it('agrega + a un número sin prefijo (caso webhook <phone>@c.us)', () => {
    expect(normalizeE164('584141234567')).toBe('+584141234567');
  });

  it('conserva un número ya en E.164', () => {
    expect(normalizeE164('+584141234567')).toBe('+584141234567');
  });

  it('quita espacios, guiones, puntos y paréntesis', () => {
    expect(normalizeE164('+58 (414) 123-45.67')).toBe('+584141234567');
  });

  it('acepta prefijo internacional 00', () => {
    expect(normalizeE164('00584141234567')).toBe('+584141234567');
  });

  it('rechaza menos de 8 dígitos', () => {
    expect(normalizeE164('+1234567')).toBeNull();
  });

  it('rechaza más de 15 dígitos', () => {
    expect(normalizeE164('+1234567890123456')).toBeNull();
  });

  it('rechaza primer dígito 0', () => {
    expect(normalizeE164('+0584141234567')).toBeNull();
  });

  it('rechaza letras y otros símbolos', () => {
    expect(normalizeE164('+58414abc4567')).toBeNull();
    expect(normalizeE164('123456789012@c.us')).toBeNull();
  });

  it('devuelve null para vacío, null o undefined', () => {
    expect(normalizeE164('')).toBeNull();
    expect(normalizeE164(null)).toBeNull();
    expect(normalizeE164(undefined)).toBeNull();
  });
});

describe('phoneToChatId', () => {
  it('quita el + y agrega el sufijo @c.us', () => {
    expect(phoneToChatId('+584141234567')).toBe('584141234567@c.us');
  });

  it('es idempotente con el formato que ya manda WAHA (dígitos pelados)', () => {
    expect(phoneToChatId('584141234567')).toBe('584141234567@c.us');
  });

  it('ignora separadores: el chatId es siempre el mismo para el mismo número', () => {
    // Crítico: (clinicId, chatId) es UNIQUE. Si dos callers normalizaran
    // distinto tendríamos dos conversaciones para el mismo paciente.
    expect(phoneToChatId('+58 (414) 123-45.67')).toBe('584141234567@c.us');
  });

  it('lanza si no queda ningún dígito, en vez de devolver "@c.us"', () => {
    // Un chatId "vacío" pasaría el UNIQUE (clinicId, chatId) y mezclaría en una
    // sola Conversation a todos los pacientes con teléfono inválido.
    expect(() => phoneToChatId('')).toThrow(/sin dígitos/);
    expect(() => phoneToChatId('sin-numeros')).toThrow(/sin dígitos/);
  });

  it('coincide con el chatId que produce el webhook al invertir normalizeE164', () => {
    const fromWaha = '584141234567@c.us';
    const stored = normalizeE164(fromWaha.replace('@c.us', ''));
    expect(stored).toBe('+584141234567');
    expect(phoneToChatId(stored as string)).toBe(fromWaha);
  });
});
