import { UnprocessableEntityException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';

/**
 * FSM del appointment según SPEC §2 (Transiciones de estado permitidas).
 *
 * ```
 * PENDIENTE   → CONFIRMADA | EN_RIESGO | CANCELADA
 * CONFIRMADA  → ATENDIDA | CANCELADA | NO_SHOW
 * EN_RIESGO   → CONFIRMADA | CANCELADA | NO_SHOW | ATENDIDA
 * ```
 *
 * Cualquier otra transición → 422 UnprocessableEntity.
 *
 * Estados terminales (`ATENDIDA`, `CANCELADA`, `NO_SHOW`) no permiten
 * salir: cualquier transición desde ellos también es 422.
 */
export const ALLOWED_TRANSITIONS: Record<
  AppointmentStatus,
  ReadonlyArray<AppointmentStatus>
> = {
  PENDIENTE: ['CONFIRMADA', 'EN_RIESGO', 'CANCELADA'],
  CONFIRMADA: ['ATENDIDA', 'CANCELADA', 'NO_SHOW'],
  EN_RIESGO: ['CONFIRMADA', 'CANCELADA', 'NO_SHOW', 'ATENDIDA'],
  ATENDIDA: [],
  CANCELADA: [],
  NO_SHOW: [],
};

export function assertTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): void {
  // Same status → no-op. No lo tratamos como transición para no explotar
  // requests idempotentes. El controller decide si actualiza campos igual.
  if (from === to) return;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new UnprocessableEntityException(
      `transición no permitida: ${from} → ${to}`,
    );
  }
}

/**
 * Estados vivos que aceptan reagendamiento (mover startAt/endAt sin cambiar
 * el status). Estados terminales (ATENDIDA/CANCELADA/NO_SHOW) NO se reagendan
 * — la política es crear una cita nueva y dejar la histórica intacta.
 */
export const RESCHEDULABLE_STATUSES: ReadonlyArray<AppointmentStatus> = [
  'PENDIENTE',
  'CONFIRMADA',
  'EN_RIESGO',
];

export function assertReschedulable(status: AppointmentStatus): void {
  if (!RESCHEDULABLE_STATUSES.includes(status)) {
    throw new UnprocessableEntityException(
      `no se puede reagendar una cita en estado ${status}`,
    );
  }
}
