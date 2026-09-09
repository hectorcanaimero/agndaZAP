/**
 * Analytics de producto (sprint 1, 2026-09-09).
 *
 * Proveedor: Plausible (sin cookies, sin PII, compatible con la postura de
 * `/seguridad`). Se activa sólo si `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` está seteada
 * en build; sin ella `track()` es un no-op y no se carga ningún script.
 *
 * Reglas:
 * - NUNCA mandar PII en `props` (nombre, teléfono, notas). Sólo enums/ids
 *   públicos (slug de clínica, ubicación del CTA, locale).
 * - Los nombres de evento son estables: los dashboards dependen de ellos.
 *
 * Embudo landing:  hero_view → cta_click → lead_form_view → lead_submitted
 * Embudo público:  slot_selected → appointment_created
 */
export type AnalyticsEvent =
  | 'hero_view'
  | 'cta_click'
  | 'lead_form_view'
  | 'lead_submitted'
  | 'slot_selected'
  | 'appointment_created';

export type AnalyticsProps = Record<string, string | number | boolean>;

type PlausibleFn = (
  event: string,
  options?: { props?: AnalyticsProps; u?: string },
) => void;

declare global {
  interface Window {
    plausible?: PlausibleFn & { q?: unknown[] };
  }
}

export const PLAUSIBLE_DOMAIN =
  process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN?.trim() || null;

/** Host de Plausible (permite instancia self-hosted). Sin trailing slash. */
export const PLAUSIBLE_HOST = (
  process.env.NEXT_PUBLIC_PLAUSIBLE_HOST?.trim() || 'https://plausible.io'
).replace(/\/$/, '');

export const analyticsEnabled = PLAUSIBLE_DOMAIN !== null;

/**
 * Registra un evento. Seguro de llamar en SSR (no hace nada) y con analytics
 * apagado (no hace nada). Nunca lanza: un fallo de analytics no puede romper
 * el flujo del paciente ni del lead.
 */
export function track(event: AnalyticsEvent, props?: AnalyticsProps): void {
  if (!analyticsEnabled || typeof window === 'undefined') return;
  try {
    const plausible = window.plausible;
    if (typeof plausible === 'function') {
      plausible(event, props ? { props } : undefined);
      return;
    }
    // El script todavía no cargó: encolamos igual que hace el snippet oficial.
    const w = window as Window & { plausible?: PlausibleFn & { q?: unknown[] } };
    const queued = ((...args: unknown[]) => {
      (queued.q = queued.q || []).push(args);
    }) as PlausibleFn & { q?: unknown[] };
    w.plausible = w.plausible ?? queued;
    w.plausible(event, props ? { props } : undefined);
  } catch {
    // silencioso a propósito
  }
}
