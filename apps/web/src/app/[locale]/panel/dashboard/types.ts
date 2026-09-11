/**
 * Contrato TypeScript del endpoint `GET /api/dashboard/metrics`.
 *
 * Fuente de verdad para el frontend. El backend (`DashboardController`) devuelve
 * exactamente esta forma. Cualquier cambio en el shape acá DEBE espejarse en
 * `apps/backend/src/dashboard/dashboard.controller.ts`.
 *
 * Notas de compat: los campos "legacy" (`noShowRate`, `byStatus`, `confirmations`,
 * `trend`) se mantienen aunque el UI nuevo derive de otros; sirven como
 * fallback y para tests existentes.
 */

export type AppointmentStatus =
  | 'PENDIENTE'
  | 'CONFIRMADA'
  | 'EN_RIESGO'
  | 'ATENDIDA'
  | 'CANCELADA'
  | 'NO_SHOW';

export interface DashboardMetrics {
  // ─── Legacy (retrocompat) ─────────────────────────────────────────────────
  noShowRate: number;
  byStatus: Record<AppointmentStatus, number>;
  confirmations: { sent: number; confirmed: number; rate: number };
  trend: Array<{
    date: string;
    created: number;
    confirmed: number;
    noShow: number;
  }>;

  // ─── Nuevos — panel operacional ───────────────────────────────────────────
  today: {
    total: number;
    confirmed: number;
    pending: number;
    attended: number;
    canceled: number;
    noShow: number;
    upcoming: Array<{
      id: string;
      startAt: string; // ISO UTC
      endAt: string;
      status: AppointmentStatus;
      patientName: string | null;
      patientPhone: string;
      serviceName: string;
      professionalName: string;
      professionalColor: string | null; // hex
    }>;
  };
  pendingConfirmation: {
    total: number;
    next: Array<{
      id: string;
      startAt: string;
      hoursUntil: number;
      patientName: string | null;
      patientPhone: string;
      serviceName: string;
      professionalName: string;
    }>;
  };
  deltas: {
    totalAppointments: DeltaValue;
    noShowRate: DeltaValue;
    confirmationRate: DeltaValue;
    revenueCents: DeltaValue;
  };
  topServices: Array<{
    id: string;
    name: string;
    count: number;
    revenueCents: number;
  }>;
  topProfessionals: Array<{
    id: string;
    name: string;
    color: string | null;
    attended: number;
    noShow: number;
  }>;
  hourHeatmap: Array<{ hour: number; count: number }>; // 24 items
  occupancyRate: number; // 0..1 semana actual
  activePatients30d: number;
  sparklines: {
    totalAppointments: number[]; // 30 items
    noShowRate: number[]; // 30 items, 0..1
  };
  botActivity: BotActivity;
}

/**
 * Actividad del bot de WhatsApp (M9).
 *
 * Los `null` NO son ceros: significan "esto todavía no se puede mostrar", y la
 * UI tiene que decirlo con palabras. Un 0% de handoff pintado como dato diría
 * que el bot lo resuelve todo solo, que es lo contrario de no saberlo.
 */
export interface BotActivity {
  windowDays: number;
  /** `false` = no hay ni un contador en el periodo. */
  hasData: boolean;
  /** Alguna lectura falló: los totales están incompletos. */
  partial: boolean;
  turns: {
    /** Incluye descartados y adjuntos: no es "turnos atendidos". */
    total: number;
    attended: number;
    unsupported: number;
    skipped: number;
    errors: number;
  };
  /** Por qué no hay desglose. Las dos causas necesitan textos distintos. */
  breakdown: 'ok' | 'not-measured' | 'below-threshold';
  /** `null` si no se mide aún, o si el periodo no llega al mínimo de turnos. */
  intents: Array<{ intent: string; count: number }> | null;
  handoffRate: number | null;
  nullAnswerRate: number | null;
  citasPorOrigen: Array<{ source: string; count: number }>;
}

export interface DeltaValue {
  current: number;
  previous: number;
  /** (current - previous) / previous. 0 si ambos 0, 1 si previous 0 y current > 0. */
  deltaPct: number;
}
