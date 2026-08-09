import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { ServicesController } from './services.controller';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

/**
 * Tests de ServicesController.
 *
 * Cubre: happy path CRUD, leak multi-tenant (user de A intentando id de B),
 * RBAC (implícito — el @Roles decorator lo cubren tests del guard).
 * SUPERADMIN sin clinicId → 400 (del TenantContext).
 */
describe('ServicesController', () => {
  let prisma: Deep<PrismaService>;
  let controller: ServicesController;

  const adminA: AuthUser = {
    userId: 'user-A',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };
  const superadmin: AuthUser = {
    userId: 'u-super',
    clinicId: null,
    role: 'SUPERADMIN',
  };

  beforeEach(() => {
    prisma = {
      service: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'svc-new', ...data }),
        ),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'svc-1', name: 'Consulta', active: true }]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'svc-1',
          name: 'Consulta',
          clinicId: 'clinic-A',
        }),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'svc-1', ...data }),
        ),
      },
      professional: {
        // Default: por cada ID pedido, devolvemos un match. Los tests
        // cross-tenant sobreescriben con `mockResolvedValueOnce([])`.
        findMany: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(
              (where.id.in as string[]).map((id: string) => ({ id })),
            ),
          ),
      },
    };
    controller = new ServicesController(prisma as unknown as PrismaService);
  });

  it('create → guarda clinicId del scope, no del body', async () => {
    const result = await controller.create(adminA, {
      name: 'Servicio X',
      durationMin: 30,
    });
    expect(prisma.service.create).toHaveBeenCalledTimes(1);
    const call = prisma.service.create.mock.calls[0][0];
    expect(call.data.clinicId).toBe('clinic-A');
    expect(call.data.name).toBe('Servicio X');
    expect(result.id).toBe('svc-new');
  });

  it('list → filtra por clinicId del user (multi-tenant)', async () => {
    await controller.list(adminA);
    const call = prisma.service.findMany.mock.calls[0][0];
    expect(call.where.clinicId).toBe('clinic-A');
    expect(call.where.active).toBe(true);
  });

  it('findOne → 404 si el service es de otra clínica', async () => {
    prisma.service.findFirst.mockResolvedValueOnce(null); // no lo encontró para clinic-A
    await expect(controller.findOne(adminA, 'svc-of-B')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('update → 404 si el service no pertenece al tenant del user', async () => {
    prisma.service.findFirst.mockResolvedValueOnce(null);
    await expect(
      controller.update(adminA, 'svc-of-B', { name: 'hack' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.service.update).not.toHaveBeenCalled();
  });

  it('remove → soft delete (active=false), no hard delete', async () => {
    await controller.remove(adminA, 'svc-1');
    const call = prisma.service.update.mock.calls[0][0];
    expect(call.data.active).toBe(false);
    expect(call.where.id).toBe('svc-1');
  });

  it('SUPERADMIN sin clinicId override → 400', async () => {
    await expect(controller.list(superadmin)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('SUPERADMIN con clinicId override → filtra por ese clinicId', async () => {
    await controller.list(superadmin, 'clinic-Z');
    const call = prisma.service.findMany.mock.calls[0][0];
    expect(call.where.clinicId).toBe('clinic-Z');
  });

  describe('M-N connect: pre-validación de tenant (audit B1)', () => {
    it('create → 400 si algún professionalId es de otra clínica', async () => {
      // El findMany(professional) devuelve MENOS matches que los pedidos → cross-tenant.
      prisma.professional.findMany.mockResolvedValueOnce([{ id: 'prof-1' }]);
      await expect(
        controller.create(adminA, {
          name: 'Servicio X',
          durationMin: 30,
          professionalIds: ['prof-1', 'prof-of-B'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // No se llegó al create con el connect malicioso.
      expect(prisma.service.create).not.toHaveBeenCalled();
    });

    it('create → happy path con professionalIds del mismo tenant', async () => {
      await controller.create(adminA, {
        name: 'Servicio X',
        durationMin: 30,
        professionalIds: ['prof-1', 'prof-2'],
      });
      const call = prisma.service.create.mock.calls[0][0];
      expect(call.data.professionals.connect).toEqual([
        { id: 'prof-1' },
        { id: 'prof-2' },
      ]);
    });

    it('update → 400 si algún professionalId es de otra clínica', async () => {
      prisma.professional.findMany.mockResolvedValueOnce([]); // cero matches
      await expect(
        controller.update(adminA, 'svc-1', {
          professionalIds: ['prof-of-B'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.service.update).not.toHaveBeenCalled();
    });
  });
});
