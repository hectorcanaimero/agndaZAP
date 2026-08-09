import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { ProfessionalsController } from './professionals.controller';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

describe('ProfessionalsController', () => {
  let prisma: Deep<PrismaService>;
  let controller: ProfessionalsController;

  const adminA: AuthUser = {
    userId: 'user-A',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };

  beforeEach(() => {
    prisma = {
      professional: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'prof-new', ...data }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'prof-1',
          name: 'Dra. Ríos',
          clinicId: 'clinic-A',
        }),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'prof-1', ...data }),
        ),
      },
      service: {
        // Default: por cada ID pedido, devolvemos un match. Cross-tenant se
        // simula con `mockResolvedValueOnce([])` o menos matches.
        findMany: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(
              (where.id.in as string[]).map((id: string) => ({ id })),
            ),
          ),
      },
    };
    controller = new ProfessionalsController(prisma as unknown as PrismaService);
  });

  it('create → guarda clinicId del scope y active=true por default', async () => {
    await controller.create(adminA, {
      name: 'Dra. Ríos',
      serviceIds: ['svc-1', 'svc-2'],
    });
    const call = prisma.professional.create.mock.calls[0][0];
    expect(call.data.clinicId).toBe('clinic-A');
    expect(call.data.active).toBe(true);
    expect(call.data.services.connect).toHaveLength(2);
  });

  it('list → sólo profesionales de la clínica del user', async () => {
    await controller.list(adminA);
    const call = prisma.professional.findMany.mock.calls[0][0];
    expect(call.where.clinicId).toBe('clinic-A');
    expect(call.where.active).toBe(true);
  });

  it('update → 404 si el prof no pertenece al tenant', async () => {
    prisma.professional.findFirst.mockResolvedValueOnce(null);
    await expect(
      controller.update(adminA, 'prof-of-B', { name: 'hack' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('remove → soft delete', async () => {
    await controller.remove(adminA, 'prof-1');
    const call = prisma.professional.update.mock.calls[0][0];
    expect(call.data.active).toBe(false);
  });

  describe('M-N connect: pre-validación de tenant (audit B1)', () => {
    it('create → 400 si algún serviceId es de otra clínica', async () => {
      prisma.service.findMany.mockResolvedValueOnce([{ id: 'svc-1' }]);
      await expect(
        controller.create(adminA, {
          name: 'Dra. Ríos',
          serviceIds: ['svc-1', 'svc-of-B'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.professional.create).not.toHaveBeenCalled();
    });

    it('create → happy path con serviceIds del mismo tenant', async () => {
      await controller.create(adminA, {
        name: 'Dra. Ríos',
        serviceIds: ['svc-1', 'svc-2'],
      });
      const call = prisma.professional.create.mock.calls[0][0];
      expect(call.data.services.connect).toEqual([
        { id: 'svc-1' },
        { id: 'svc-2' },
      ]);
    });

    it('update → 400 si algún serviceId es de otra clínica', async () => {
      prisma.service.findMany.mockResolvedValueOnce([]);
      await expect(
        controller.update(adminA, 'prof-1', {
          serviceIds: ['svc-of-B'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.professional.update).not.toHaveBeenCalled();
    });
  });
});
