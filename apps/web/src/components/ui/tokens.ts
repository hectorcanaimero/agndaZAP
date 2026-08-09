/**
 * Design tokens semánticos de AgendaZap.
 *
 * Fuente de verdad de las clases Tailwind para estados y visualizaciones.
 * Cualquier componente que necesite colorear un status DEBE consumir estos
 * tokens en vez de hardcodear clases o hex — así garantizamos consistencia
 * y hacemos que un rebranding se limite a este archivo + `tailwind.config.ts`.
 *
 * Convención:
 * - `intense`: variante fuerte (usar en badges chicos, inline text).
 * - `subtle`: variante liviana (usar en bloques grandes tipo week view).
 * - `dot`: solid color para dots de hover previews u otros contextos.
 *
 * Ver `docs/ux/2026-08-09-design-system-tokens-y-dedup.md`.
 */

import type { AppointmentStatus } from './badge';

// ---------------------------------------------------------------------------
// Appointment status — paleta de estados de cita (fuente única).
// ---------------------------------------------------------------------------

export interface AppointmentStatusToken {
  /** Variante fuerte — para badge chico, chips inline. */
  intense: string;
  /** Variante liviana — para bloques grandes de la week view. */
  subtle: string;
  /** Color solid para dots de hover previews u otros contextos. */
  dot: string;
}

export const APPOINTMENT_STATUS_TOKENS: Record<
  AppointmentStatus,
  AppointmentStatusToken
> = {
  PENDIENTE: {
    intense: 'bg-yellow-100 text-yellow-900 border-yellow-300',
    subtle: 'bg-yellow-50 border-yellow-300 text-yellow-900',
    dot: 'bg-yellow-500',
  },
  CONFIRMADA: {
    intense: 'bg-green-100 text-green-900 border-green-300',
    subtle: 'bg-green-50 border-green-300 text-green-900',
    dot: 'bg-green-500',
  },
  EN_RIESGO: {
    intense: 'bg-orange-100 text-orange-900 border-orange-300',
    subtle: 'bg-orange-50 border-orange-300 text-orange-900',
    dot: 'bg-orange-500',
  },
  ATENDIDA: {
    intense: 'bg-blue-100 text-blue-900 border-blue-300',
    subtle: 'bg-blue-50 border-blue-300 text-blue-900',
    dot: 'bg-blue-500',
  },
  CANCELADA: {
    intense: 'bg-gray-100 text-gray-700 border-gray-300',
    subtle: 'bg-gray-50 border-gray-300 text-gray-700',
    dot: 'bg-gray-400',
  },
  NO_SHOW: {
    intense: 'bg-red-100 text-red-900 border-red-300',
    subtle: 'bg-red-50 border-red-300 text-red-900',
    dot: 'bg-red-500',
  },
};

// ---------------------------------------------------------------------------
// Conversation state — paleta distinta a citas para evitar colisión semántica.
// ---------------------------------------------------------------------------
// Rationale (docs/ux/2026-08-09-design-system-tokens-y-dedup.md):
// - BOT usa slate (neutro): el bot atiende, no requiere atención humana.
// - NEEDS_HUMAN usa amber (urgencia): requiere que un operador tome acción.
// - HUMAN usa brand (activo por nosotros): la clínica ya está respondiendo.
//
// Si un operador ve verde en conversación piensa "confirmada" (paleta cita).
// Usar brand-100 acá es intencional: "verde" no es "confirmada" es "nosotros
// tomamos el control" — semantic separation.

export type ConversationState = 'BOT' | 'NEEDS_HUMAN' | 'HUMAN';

export const CONVERSATION_STATE_TOKENS: Record<ConversationState, string> = {
  BOT: 'bg-slate-100 text-slate-800 border-slate-300',
  NEEDS_HUMAN: 'bg-amber-100 text-amber-900 border-amber-300',
  HUMAN: 'bg-brand-100 text-brand-800 border-brand-300',
};

export type ConversationStateToken =
  (typeof CONVERSATION_STATE_TOKENS)[ConversationState];

// ---------------------------------------------------------------------------
// Trend chart — colores para el SVG del dashboard (fill-* de Tailwind).
// ---------------------------------------------------------------------------

export interface TrendChartColors {
  /** Barra "creadas". */
  created: string;
  /** Barra "no-show". */
  noShow: string;
  /** Reservado para futuras series neutrales. */
  neutral: string;
}

export const TREND_CHART_COLORS: TrendChartColors = {
  created: 'fill-brand-600',
  noShow: 'fill-red-500',
  neutral: 'fill-slate-400',
};
