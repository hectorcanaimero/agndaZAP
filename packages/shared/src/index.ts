// Tipos compartidos entre backend (NestJS) y web (Next.js).
export type AppointmentStatus =
  | 'PENDIENTE' | 'CONFIRMADA' | 'EN_RIESGO' | 'ATENDIDA' | 'CANCELADA' | 'NO_SHOW';

export interface Slot { startAt: string; endAt: string; }

export interface CreateAppointmentInput {
  serviceId: string;
  professionalId: string;
  startAt: string; // ISO
  patient: { phone: string; name?: string };
  notes?: string;
}

export interface PublicBookingInput extends CreateAppointmentInput {
  clinicSlug: string;
  consent: boolean;
}
