/**
 * Construcción de URLs de la web pública, en un solo sitio (S21).
 *
 * `WEB_BASE_URL` es el único env que define el dominio, y hoy en producción
 * apunta a un `sslip.io` por IP. Los tokens de gestión viven hasta 30 días, así
 * que un link emitido hoy tiene que seguir funcionando después de mover el
 * dominio: con la URL construida en un solo lugar, ese cambio es un env y nada
 * más.
 *
 * El trailing slash se normaliza siempre: `https://showly.us/` y
 * `https://showly.us` tienen que dar la misma URL.
 */

export function webBaseUrl(): string {
  return (process.env.WEB_BASE_URL ?? 'http://localhost:3000').replace(
    /\/+$/,
    '',
  );
}

/**
 * Página pública de agendamiento, SIN token. Se usa en el saludo y en el cierre
 * con acción: mostrarla no debe escribir una `SchedulingSession` en DB.
 */
export function schedulingUrl(locale: string, slug: string): string {
  return `${webBaseUrl()}/${locale}/agendar/${slug}`;
}

/**
 * Página de agendamiento con token de prefill (`SchedulingSessionService.create`).
 * TTL corto — 30 min por defecto.
 */
export function schedulingUrlWithToken(
  locale: string,
  slug: string,
  token: string,
): string {
  return `${schedulingUrl(locale, slug)}?t=${token}`;
}

/**
 * Página de gestión de una cita concreta (ADR 0020): ver, cancelar o cambiar
 * horario. El token ES la autorización.
 */
export function manageAppointmentUrl(
  locale: string,
  slug: string,
  token: string,
): string {
  return `${schedulingUrl(locale, slug)}/cita?t=${token}`;
}
