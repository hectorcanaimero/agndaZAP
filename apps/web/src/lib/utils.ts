import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Concatena clases CSS deduplicando conflictos de Tailwind.
 *
 * Reemplaza la versión previa (`.filter(Boolean).join(' ')`) por la combinación
 * estándar de shadcn/ui: `clsx` para acepta múltiples formatos (strings, arrays,
 * objetos condicionales, valores falsy) y `tailwind-merge` para resolver
 * conflictos como `p-2 p-4` → `p-4`. Necesaria para que los componentes de
 * shadcn (variants con `cva`, overrides en llamadas) generen la clase final correcta.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Devuelve "YYYY-MM-DD" que representa "hoy 00:00" en la TZ de la clínica.
 *
 * Anti-drift: evita usar `new Date().toISOString()` del navegador (que puede
 * estar en otra TZ o con reloj desincronizado si el paciente viaja / usa VPN
 * / tiene el reloj mal), lo que puede terminar pidiendo slots desde una fecha
 * "en el pasado" según la clínica y hacer que el backend descarte slots
 * legítimos.
 *
 * Usa `Intl.DateTimeFormat('en-CA', ...)` porque el locale `en-CA` produce
 * nativamente el formato ISO `YYYY-MM-DD` sin necesidad de armarlo a mano.
 *
 * @param timezone IANA TZ (ej. 'America/Argentina/Buenos_Aires').
 * @returns fecha `YYYY-MM-DD` correspondiente al "hoy" en la TZ dada.
 *
 * @see ADR 0006 §Reglas — sin Luxon en apps/web.
 */
export function todayStartInTZ(timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}
