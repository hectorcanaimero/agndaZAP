/**
 * ¿Agenda y reagenda el bot por chat, con la FSM de horarios? (ADR 0024)
 *
 * Apagado por defecto: el bot manda el link de la web y no pregunta servicio,
 * profesional ni horario. `BOT_CHAT_BOOKING_ENABLED=true` restaura la FSM entera
 * —flujo y textos— como vuelta atrás durante el piloto. Cuando el piloto cierre
 * se borran la FSM de agendamiento y este flag.
 *
 * Se lee en cada llamada y no al arrancar para que los tests puedan cambiarlo
 * por caso, igual que `BOT_TYPING_ENABLED`.
 */
export function chatBookingEnabled(): boolean {
  return process.env.BOT_CHAT_BOOKING_ENABLED === 'true';
}
