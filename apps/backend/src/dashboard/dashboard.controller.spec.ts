import { DateTime } from 'luxon';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardController } from './dashboard.controller';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

describe('DashboardController', () => {
  let prisma: Deep<PrismaService>;
  let controller: DashboardController;

  const adminA: AuthUser = {
    userId: 'u',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };
  const superadmin: AuthUser = {
    userId: 'u-s',
    clinicId: null,
    role: 'SUPERADMIN',
  };
  // Post-ADR 0014: SUPERADMIN debe impersonar antes de operar sobre datos de
  // clínica. El JWT impersonado trae clinicId + impersonatedBy.
  const superadminImpersonatingZ: AuthUser = {
    userId: 'u-s',
    clinicId: 'clinic-Z',
    role: 'SUPERADMIN',
    impersonatedBy: 'u-s',
  };

  beforeEach(() => {
    const tz = 'America/Caracas';
    const now = DateTime.now().setZone(tz);
    const yesterday = now.minus({ days: 1 });
    // Dataset: 3 ATENDIDA, 1 NO_SHOW, 1 CONFIRMADA, 1 CANCELADA en últimos 30d.
    // No-show rate esperado sobre "closed": 1 / (3+1) = 0.25.
    const seed30 = [
      { status: 'ATENDIDA', startAt: yesterday.toJSDate(), confirmedAt: null },
      { status: 'ATENDIDA', startAt: yesterday.toJSDate(), confirmedAt: null },
      { status: 'ATENDIDA', startAt: yesterday.toJSDate(), confirmedAt: null },
      { status: 'NO_SHOW', startAt: yesterday.toJSDate(), confirmedAt: null },
      {
        status: 'CONFIRMADA',
        startAt: now.plus({ days: 1 }).toJSDate(),
        confirmedAt: yesterday.toJSDate(),
      },
      { status: 'CANCELADA', startAt: yesterday.toJSDate(), confirmedAt: null },
    ];
    prisma = {
      clinic: {
        findUnique: jest.fn().mockResolvedValue({ timezone: tz }),
      },
      appointment: {
        findMany: jest.fn().mockResolvedValue(seed30),
        count: jest.fn().mockResolvedValue(3), // confirmedCount
      },
      reminder: {
        count: jest.fn().mockResolvedValue(10), // sentCount
      },
    };
    controller = new DashboardController(prisma as unknown as PrismaService);
  });

  it('devuelve estructura completa con byStatus + noShowRate + confirmations + trend', async () => {
    const m = await controller.metrics(adminA);
    expect(m.byStatus.ATENDIDA).toBe(3);
    expect(m.byStatus.NO_SHOW).toBe(1);
    expect(m.byStatus.CONFIRMADA).toBe(1);
    expect(m.byStatus.CANCELADA).toBe(1);
    expect(m.noShowRate).toBeCloseTo(0.25, 4);
    expect(m.confirmations.sent).toBe(10);
    expect(m.confirmations.confirmed).toBe(3);
    expect(m.confirmations.rate).toBeCloseTo(0.3, 4);
    expect(m.trend).toHaveLength(14);
    expect(m.trend[0]).toHaveProperty('date');
    expect(m.trend[0]).toHaveProperty('created');
  });

  it('sin reminders enviados: rate=0 (guard contra división por cero)', async () => {
    prisma.reminder.count.mockResolvedValueOnce(0);
    const m = await controller.metrics(adminA);
    expect(m.confirmations.rate).toBe(0);
  });

  it('sin closed appts: noShowRate=0', async () => {
    prisma.appointment.findMany.mockResolvedValueOnce([]);
    const m = await controller.metrics(adminA);
    expect(m.noShowRate).toBe(0);
  });

  it('SUPERADMIN sin impersonation activa → 400', async () => {
    // Post-ADR 0014: sin JWT impersonado, no hay acceso a metrics de una
    // clínica. El escape hatch (`?clinicId=`) ya no habilita.
    await expect(controller.metrics(superadmin)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('impersonar'),
    });
  });

  it('SUPERADMIN sin impersonation + intent override → sigue siendo 400', async () => {
    // Fase 6: el parámetro ?clinicId= fue removido. Sin JWT impersonado,
    // no hay forma de escapar — el SUPERADMIN está forzado a impersonar.
    await expect(
      controller.metrics(superadmin),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.clinic.findUnique).not.toHaveBeenCalled();
  });

  it('SUPERADMIN impersonando (JWT con clinicId) → usa el clinicId del JWT para lookup', async () => {
    await controller.metrics(superadminImpersonatingZ);
    const call = prisma.clinic.findUnique.mock.calls[0][0];
    expect(call.where.id).toBe('clinic-Z');
  });
});
