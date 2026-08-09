import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { TimeOffController } from './time-off.controller';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

describe('TimeOffController', () => {
  let prisma: Deep<PrismaService>;
  let controller: TimeOffController;

  const adminA: AuthUser = {
    userId: 'u',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };

  const tomorrow9 = DateTime.now()
    .setZone('America/Caracas')
    .plus({ days: 1 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  const tomorrow18 = tomorrow9.set({ hour: 18 });

  beforeEach(() => {
    prisma = {
      clinic: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ timezone: 'America/Caracas' }),
      },
      timeOff: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'to-new', ...data }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'to-1',
          clinicId: 'clinic-A',
          startAt: tomorrow9.toJSDate(),
          endAt: tomorrow18.toJSDate(),
        }),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'to-1', ...data }),
        ),
        delete: jest.fn().mockResolvedValue({ id: 'to-1' }),
      },
      professional: {
        findFirst: jest.fn().mockResolvedValue({ id: 'prof-1' }),
      },
    };
    controller = new TimeOffController(prisma as unknown as PrismaService);
  });

  it('create → 400 si endAt <= startAt', async () => {
    await expect(
      controller.create(adminA, {
        startAt: tomorrow9.toISO()!,
        endAt: tomorrow9.toISO()!,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create → 404 si professionalId no pertenece a la clínica', async () => {
    prisma.professional.findFirst.mockResolvedValueOnce(null);
    await expect(
      controller.create(adminA, {
        startAt: tomorrow9.toISO()!,
        endAt: tomorrow18.toISO()!,
        professionalId: 'prof-of-B',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('create happy path → guarda clinicId del scope y JSDate', async () => {
    await controller.create(adminA, {
      startAt: tomorrow9.toISO()!,
      endAt: tomorrow18.toISO()!,
      reason: 'Vacaciones',
    });
    const call = prisma.timeOff.create.mock.calls[0][0];
    expect(call.data.clinicId).toBe('clinic-A');
    expect(call.data.startAt).toBeInstanceOf(Date);
    expect(call.data.endAt).toBeInstanceOf(Date);
    expect(call.data.reason).toBe('Vacaciones');
  });

  it('update → 404 si no pertenece al tenant', async () => {
    prisma.timeOff.findFirst.mockResolvedValueOnce(null);
    await expect(
      controller.update(adminA, 'to-of-B', { reason: 'hack' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
