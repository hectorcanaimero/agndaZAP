import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ClinicStatus } from '@prisma/client';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminAuditInterceptor } from './admin-audit.interceptor';
import { AdminAuditService } from './admin-audit.service';
import { AdminClinicsController } from './admin-clinics.controller';
import { AdminClinicsService } from './admin-clinics.service';
import { CreateClinicDto } from './dto/create-clinic.dto';
import { ListClinicsQueryDto } from './dto/list-clinics-query.dto';
import { SuspendClinicDto } from './dto/suspend-clinic.dto';
import { UpdateClinicDto } from './dto/update-clinic.dto';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const serviceMock = {
  create: jest.fn(),
  list: jest.fn(),
  get: jest.fn(),
  update: jest.fn(),
  suspend: jest.fn(),
  reactivate: jest.fn(),
};

// Interceptor que no hace nada — no queremos side-effects de auditoría en tests del controller.
const auditInterceptorMock = {
  intercept: jest.fn((_ctx: unknown, next: { handle: () => unknown }) => next.handle()),
};

// Stub de AdminAuditService para satisfacer la DI del AdminAuditInterceptor.
const auditServiceMock = {
  logAction: jest.fn().mockResolvedValue({}),
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_CREATE_RESULT = {
  id: 'clinic-1',
  clinic: {
    id: 'clinic-1',
    name: 'Clínica Test',
    slug: 'clinica-test',
    timezone: 'America/Caracas',
    locale: 'es',
    wahaSession: 'waha-1',
    status: ClinicStatus.ACTIVE,
  },
  admin: { id: 'user-1', email: 'admin@test.com', name: 'Admin Test' },
  invitation: {
    url: 'http://localhost:3002/es/invite/deadbeef',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    emailSent: true,
  },
};

/** Stub del AuthUser que inyectaría el JwtAuthGuard. Solo `userId` importa. */
const FAKE_SUPER: {
  userId: string;
  role: 'SUPERADMIN';
  clinicId: null;
} = {
  userId: 'user-super',
  role: 'SUPERADMIN',
  clinicId: null,
};

const FAKE_LIST_RESULT = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
};

const FAKE_GET_RESULT = {
  clinic: { ...FAKE_CREATE_RESULT.clinic, suspendedAt: null, suspendedReason: null, address: null },
  metrics: {
    professionals: 3,
    servicesActive: 5,
    appointmentsLast30d: 20,
    noShowRateLast30d: 0.1,
    patients: 50,
  },
};

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('AdminClinicsController', () => {
  let controller: AdminClinicsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminClinicsController],
      providers: [
        { provide: AdminClinicsService, useValue: serviceMock },
        { provide: AdminAuditInterceptor, useValue: auditInterceptorMock },
        { provide: AdminAuditService, useValue: auditServiceMock },
        Reflector,
      ],
    })
      // Anulamos RolesGuard para probar la lógica de roles de forma explícita abajo.
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AdminClinicsController>(AdminClinicsController);
    jest.clearAllMocks();
  });

  // ── POST / ──────────────────────────────────────────────────────────────────

  describe('create (POST /)', () => {
    const dto: CreateClinicDto = {
      name: 'Clínica Test',
      slug: 'clinica-test',
      wahaSession: 'waha-1',
      admin: { email: 'admin@test.com', name: 'Admin Test' },
    };

    it('delega al service pasando invitedByUserId del super', async () => {
      serviceMock.create.mockResolvedValueOnce(FAKE_CREATE_RESULT);

      const result = await controller.create(FAKE_SUPER, dto);

      // El controller inyecta `invitedByUserId` desde el AuthUser para que
      // la Invitation quede trazada al super que la disparó.
      expect(serviceMock.create).toHaveBeenCalledWith({
        ...dto,
        invitedByUserId: FAKE_SUPER.userId,
      });
      expect(result.id).toBe('clinic-1');
      expect(result.admin.email).toBe('admin@test.com');
      expect(result.invitation.url).toContain('/invite/');
    });

    it('propaga el error del service sin modificarlo', async () => {
      serviceMock.create.mockRejectedValueOnce(new Error('slug duplicado'));

      await expect(controller.create(FAKE_SUPER, dto)).rejects.toThrow(
        'slug duplicado',
      );
    });

    it('SUPERADMIN puede acceder — RolesGuard con rol correcto', () => {
      const reflector = new Reflector();
      const guard = new RolesGuard(reflector);

      // Simulamos un contexto con clase que tiene @Roles('SUPERADMIN')
      const mockContext = {
        getHandler: () => AdminClinicsController.prototype.create,
        getClass: () => AdminClinicsController,
        switchToHttp: () => ({
          getRequest: () => ({ user: { userId: 'u-1', role: 'SUPERADMIN', clinicId: null } }),
        }),
      };

      // Con SUPERADMIN debe pasar
      expect(guard.canActivate(mockContext as never)).toBe(true);
    });

    it('CLINIC_ADMIN recibe 403 — RolesGuard con rol incorrecto', () => {
      const reflector = new Reflector();
      const guard = new RolesGuard(reflector);

      const mockContext = {
        getHandler: () => AdminClinicsController.prototype.create,
        getClass: () => AdminClinicsController,
        switchToHttp: () => ({
          getRequest: () => ({ user: { userId: 'u-2', role: 'CLINIC_ADMIN', clinicId: 'c-1' } }),
        }),
      };

      expect(() => guard.canActivate(mockContext as never)).toThrow(ForbiddenException);
    });
  });

  // ── GET / ───────────────────────────────────────────────────────────────────

  describe('list (GET /)', () => {
    it('delega al service con defaults page=1 pageSize=20 cuando no se proveen', async () => {
      serviceMock.list.mockResolvedValueOnce(FAKE_LIST_RESULT);

      const q = new ListClinicsQueryDto();
      await controller.list(q);

      expect(serviceMock.list).toHaveBeenCalledWith({
        status: undefined,
        search: undefined,
        page: 1,
        pageSize: 20,
      });
    });

    it('pasa filtros opcionales al service cuando se proveen', async () => {
      serviceMock.list.mockResolvedValueOnce(FAKE_LIST_RESULT);

      const q: ListClinicsQueryDto = {
        status: ClinicStatus.SUSPENDED,
        search: 'dental',
        page: 2,
        pageSize: 10,
      };

      await controller.list(q);

      expect(serviceMock.list).toHaveBeenCalledWith({
        status: ClinicStatus.SUSPENDED,
        search: 'dental',
        page: 2,
        pageSize: 10,
      });
    });

    it('devuelve el resultado del service sin transformar', async () => {
      const customResult = { items: [], total: 42, page: 2, pageSize: 5 };
      serviceMock.list.mockResolvedValueOnce(customResult);

      const result = await controller.list({ page: 2, pageSize: 5 });

      expect(result.total).toBe(42);
    });
  });

  // ── GET /:id ────────────────────────────────────────────────────────────────

  describe('getOne (GET /:id)', () => {
    it('delega al service con el id del param', async () => {
      serviceMock.get.mockResolvedValueOnce(FAKE_GET_RESULT);

      await controller.getOne('clinic-1');

      expect(serviceMock.get).toHaveBeenCalledWith('clinic-1');
    });

    it('devuelve clinic + metrics', async () => {
      serviceMock.get.mockResolvedValueOnce(FAKE_GET_RESULT);

      const result = await controller.getOne('clinic-1');

      expect(result.clinic.id).toBe('clinic-1');
      expect(result.metrics.professionals).toBe(3);
    });

    it('propaga NotFoundException del service', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      serviceMock.get.mockRejectedValueOnce(new NotFoundException('not found'));

      await expect(controller.getOne('inexistente')).rejects.toThrow(NotFoundException);
    });
  });

  // ── PATCH /:id ──────────────────────────────────────────────────────────────

  describe('update (PATCH /:id)', () => {
    it('delega al service con id y dto', async () => {
      serviceMock.update.mockResolvedValueOnce({ id: 'clinic-1' });

      const dto: UpdateClinicDto = { name: 'Nuevo Nombre' };
      await controller.update('clinic-1', dto);

      expect(serviceMock.update).toHaveBeenCalledWith('clinic-1', dto);
    });

    it('devuelve { id } tras la actualización', async () => {
      serviceMock.update.mockResolvedValueOnce({ id: 'clinic-1' });

      const result = await controller.update('clinic-1', { name: 'X' });

      expect(result).toEqual({ id: 'clinic-1' });
    });
  });

  // ── POST /:id/suspend ────────────────────────────────────────────────────────

  describe('suspend (POST /:id/suspend)', () => {
    it('delega al service con id y reason', async () => {
      serviceMock.suspend.mockResolvedValueOnce({ id: 'clinic-1' });

      const dto: SuspendClinicDto = { reason: 'pago vencido' };
      await controller.suspend('clinic-1', dto);

      expect(serviceMock.suspend).toHaveBeenCalledWith('clinic-1', 'pago vencido');
    });

    it('propaga ConflictException si ya estaba suspendida', async () => {
      const { ConflictException } = await import('@nestjs/common');
      serviceMock.suspend.mockRejectedValueOnce(new ConflictException('ya suspendida'));

      await expect(
        controller.suspend('clinic-1', { reason: 'otra razón' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── POST /:id/reactivate ─────────────────────────────────────────────────────

  describe('reactivate (POST /:id/reactivate)', () => {
    it('delega al service con el id', async () => {
      serviceMock.reactivate.mockResolvedValueOnce({ id: 'clinic-1' });

      await controller.reactivate('clinic-1');

      expect(serviceMock.reactivate).toHaveBeenCalledWith('clinic-1');
    });

    it('propaga ConflictException si ya estaba activa', async () => {
      const { ConflictException } = await import('@nestjs/common');
      serviceMock.reactivate.mockRejectedValueOnce(new ConflictException('ya activa'));

      await expect(controller.reactivate('clinic-1')).rejects.toThrow(ConflictException);
    });

    it('devuelve { id } tras la reactivación', async () => {
      serviceMock.reactivate.mockResolvedValueOnce({ id: 'clinic-1' });

      const result = await controller.reactivate('clinic-1');

      expect(result).toEqual({ id: 'clinic-1' });
    });
  });
});
