/**
 * Helpers compartidos por los specs E2E. Cero dependencia de la app: sólo
 * constantes del seed (`apps/backend/prisma/seed.ts`) y utilidades puras.
 */
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4102';
export const CLINIC_SLUG = 'demo';
export const CLINIC_TZ = 'America/Caracas';

/** Nombres exactos del seed — si cambian ahí, cambiar acá. */
export const SEED = {
  service: 'Consulta general',
  professionalUi: 'Dra. Ana Ríos',
  professionalApi: 'Dr. Luis Pérez',
} as const;

/**
 * Teléfono E.164 venezolano ficticio y único por corrida. El backend upsertea
 * pacientes por teléfono, así que un número fijo reutilizaría el mismo
 * Patient entre corridas (no rompe, pero ensucia el seed).
 */
export function uniquePhone(): string {
  const suffix = String(Date.now() % 10_000_000).padStart(7, '0');
  return `+58412${suffix}`;
}

/** YYYY-MM-DD de hoy en la TZ de la clínica (mismo cálculo que el web). */
export function todayInClinicTZ(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * El rate-limit público (`RateLimit(n)` en `public.controller.ts`) cuenta en
 * Redis con clave `ratelimit:<slug>:<ip>:<minuto>` — UNA sola clave por
 * slug+IP compartida entre `GET :slug` (30/min), `GET availability` (30/min)
 * y `POST appointments` (5/min). Los GETs del spec de UI (SSR + slots) y los
 * de este spec agotan el presupuesto de 5 del POST si caen en el mismo
 * minuto → 429 en la primera creación. Esperamos al próximo bucket de minuto
 * para arrancar con contador en cero (máx. 60 s).
 */
export async function waitForFreshRateLimitBucket(): Promise<void> {
  const now = Date.now();
  const nextBucket = (Math.floor(now / 60_000) + 1) * 60_000;
  await new Promise((r) => setTimeout(r, nextBucket - now + 250));
}
