import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { BusinessHoursController } from './business-hours.controller';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

describe('BusinessHoursController', () => {
  let prisma: Deep<PrismaService>;
  let controller: BusinessHoursController;

  const adminA: AuthUser = {
    userId: 'u',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };

  beforeEach(() => {
    prisma = {
      businessHour: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'bh-new', ...data }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'bh-1',
          clinicId: 'clinic-A',
          startMinutes: 540,
          endMinutes: 1080,
        }),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'bh-1', ...data }),
        ),
        delete: jest.fn().mockResolvedValue({ id: 'bh-1' }),
      },
      professional: {
        findFirst: jest.fn().mockResolvedValue({ id: 'prof-1' }),
      },
    };
    controller = new BusinessHoursController(prisma as unknown as PrismaService);
  });

  it('create → rechaza endMinutes <= startMinutes con 400', async () => {
    await expect(
      controller.create(adminA, {
        weekday: 1,
        startMinutes: 600,
        endMinutes: 600,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create → guarda clinicId del scope', async () => {
    await controller.create(adminA, {
      weekday: 1,
      startMinutes: 540,
      endMinutes: 1080,
    });
    const call = prisma.businessHour.create.mock.calls[0][0];
    expect(call.data.clinicId).toBe('clinic-A');
  });

  it('create con professionalId → verifica que pertenece a la clínica', async () => {
    prisma.professional.findFirst.mockResolvedValueOnce(null); // no lo encontró
    await expect(
      controller.create(adminA, {
        weekday: 1,
        startMinutes: 540,
        endMinutes: 1080,
        professionalId: 'prof-of-B',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update → 404 si no pertenece al tenant', async () => {
    prisma.businessHour.findFirst.mockResolvedValueOnce(null);
    await expect(
      controller.update(adminA, 'bh-of-B', { weekday: 3 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('remove → 204 hard delete', async () => {
    await controller.remove(adminA, 'bh-1');
    expect(prisma.businessHour.delete).toHaveBeenCalledWith({
      where: { id: 'bh-1' },
    });
  });
});
