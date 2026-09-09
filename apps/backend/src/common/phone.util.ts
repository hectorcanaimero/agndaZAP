/**
 * Normalización única de teléfonos a E.164 (`+<8..15 dígitos>`).
 *
 * Contrato de almacenamiento: `Patient.phone` y `Conversation.phone` se guardan
 * SIEMPRE con `+` inicial. Las tres vías de alta (webhook WAHA, página pública
 * y panel) tienen que pasar por acá para que `(clinicId, phone)` identifique al
 * mismo paciente.
 *
 * - Quita espacios, guiones, puntos y paréntesis.
 * - Acepta `+` inicial opcional o prefijo `00` internacional.
 * - Exige 8–15 dígitos, primer dígito distinto de 0 (E.164).
 * - Devuelve `null` si no se puede normalizar (nunca lanza).
 *
 * Reparto de responsabilidades: los DTOs (`@Matches(/^\+?[1-9]\d{7,14}$/)`)
 * son la barrera de validación de entrada (400 al usuario); este helper es el
 * canon de almacenamiento. Un `null` acá tras pasar el DTO es un bug, no un
 * caso de usuario — por eso los controllers lo tratan como 400 defensivo.
 */
export function normalizeE164(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;

  let cleaned = input.replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('00')) cleaned = cleaned.slice(2);
  else if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);

  if (!/^[1-9]\d{7,14}$/.test(cleaned)) return null;
  return `+${cleaned}`;
}
