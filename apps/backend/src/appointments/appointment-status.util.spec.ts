import { UnprocessableEntityException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { assertTransition } from './appointment-status.util';

/**
 * FSM del appointment según SPEC §2.
 * PENDIENTE   → CONFIRMADA | EN_RIESGO | CANCELADA
 * CONFIRMADA  → ATENDIDA | CANCELADA | NO_SHOW
 * EN_RIESGO   → CONFIRMADA | CANCELADA | NO_SHOW | ATENDIDA
 * ATENDIDA/CANCELADA/NO_SHOW → nada (terminales).
 *
 * Son las transiciones que un HUMANO puede pedir por `PATCH /:id/status`. El
 * reset a PENDIENTE que hace el reagendamiento es una operación de sistema y
 * NO entra acá a propósito (ver el util).
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
    // El reset a PENDIENTE del reagendamiento es de sistema: por `PATCH
    // /status` sigue siendo 422, porque esa ruta no limpiaría `confirmedAt` ni
    // reprogramaría nada y dejaría la cita contada dos veces en el dashboard.
    ['CONFIRMADA', 'PENDIENTE'],
    ['EN_RIESGO', 'PENDIENTE'],
    ['CONFIRMADA', 'EN_RIESGO'],
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
