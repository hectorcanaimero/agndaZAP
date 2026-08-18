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
}

export interface DeltaValue {
  current: number;
  previous: number;
  /** (current - previous) / previous. 0 si ambos 0, 1 si previous 0 y current > 0. */
  deltaPct: number;
}
