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

/**
 * Teléfono E.164 → `chatId` de WhatsApp phone-based (`<digitos>@c.us`).
 *
 * Es el formato con el que WAHA entrega los mensajes entrantes de un contacto
 * sin LID, y por lo tanto el que termina en `Conversation.chatId`. Vive acá —y
 * no duplicado en cada caller— porque `(clinicId, chatId)` es UNIQUE: si dos
 * sitios arman el id distinto (con `+`, con guiones) se crean dos
 * conversaciones para el mismo paciente y el bot pierde el hilo.
 *
 * Ojo: NO cubre los `@lid`. WhatsApp no expone LID→phone públicamente, así que
 * desde un teléfono solo podemos construir la forma `@c.us`. Los callers que
 * busquen una conversación existente deben preferir la búsqueda por `phone`
 * antes de caer a este id derivado (ver `follow-ups.processor.ts`).
 *
 * Precondición: `phone` ya validado (DTO o `normalizeE164`). Lanza si no queda
 * ningún dígito, en vez de devolver `'@c.us'`: ese id "vacío" pasaría el UNIQUE
 * y todos los teléfonos inválidos de una clínica compartirían la MISMA fila de
 * `Conversation`, mezclando conversaciones de pacientes distintos. Mejor
 * romper acá que corromper datos.
 */
export function phoneToChatId(phone: string): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) {
    throw new Error('phoneToChatId: teléfono sin dígitos');
  }
  return `${digits}@c.us`;
}
