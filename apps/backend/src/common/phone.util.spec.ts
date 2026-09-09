import { normalizeE164 } from './phone.util';

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
