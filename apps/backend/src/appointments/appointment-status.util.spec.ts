import { UnprocessableEntityException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { assertTransition } from './appointment-status.util';

/**
 * FSM del appointment según SPEC §2.
 * PENDIENTE   → CONFIRMADA | EN_RIESGO | CANCELADA
 * CONFIRMADA  → ATENDIDA | CANCELADA | NO_SHOW
 * EN_RIESGO   → CONFIRMADA | CANCELADA | NO_SHOW | ATENDIDA
 * ATENDIDA/CANCELADA/NO_SHOW → nada (terminales).
 */
describe('assertTransition', () => {
  const allowed: [AppointmentStatus, AppointmentStatus][] = [
    ['PENDIENTE', 'CONFIRMADA'],
    ['PENDIENTE', 'EN_RIESGO'],
    ['PENDIENTE', 'CANCELADA'],
    ['CONFIRMADA', 'ATENDIDA'],
    ['CONFIRMADA', 'CANCELADA'],
    ['CONFIRMADA', 'NO_SHOW'],
    ['EN_RIESGO', 'CONFIRMADA'],
    ['EN_RIESGO', 'CANCELADA'],
    ['EN_RIESGO', 'NO_SHOW'],
    ['EN_RIESGO', 'ATENDIDA'],
  ];
  const illegal: [AppointmentStatus, AppointmentStatus][] = [
    ['PENDIENTE', 'ATENDIDA'], // no se puede saltar
    ['PENDIENTE', 'NO_SHOW'],
    ['CONFIRMADA', 'PENDIENTE'],
    ['CONFIRMADA', 'EN_RIESGO'],
    ['EN_RIESGO', 'PENDIENTE'],
    ['ATENDIDA', 'CONFIRMADA'],
    ['ATENDIDA', 'CANCELADA'],
    ['CANCELADA', 'PENDIENTE'],
    ['CANCELADA', 'CONFIRMADA'],
    ['NO_SHOW', 'ATENDIDA'],
    ['NO_SHOW', 'CONFIRMADA'],
  ];

  test.each(allowed)('permite %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  test.each(illegal)('rechaza %s → %s con 422', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(
      UnprocessableEntityException,
    );
  });

  it('same-status no-op → no tira', () => {
    for (const s of [
      'PENDIENTE',
      'CONFIRMADA',
      'EN_RIESGO',
      'ATENDIDA',
      'CANCELADA',
      'NO_SHOW',
    ] as AppointmentStatus[]) {
      expect(() => assertTransition(s, s)).not.toThrow();
    }
  });
});
