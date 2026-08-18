import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminAction } from '@prisma/client';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminAuditController } from './admin-audit.controller';
import type { AdminAuditService, ListAuditResult } from './admin-audit.service';
import type { ListAuditQueryDto } from './dto/list-audit-query.dto';

// ─── helpers ──────────────────────────────────────────────────────────────

const fakeActor = { id: 'u-1', email: 'super@showly.io', name: 'Super Admin' };
const fakeItem = {
  id: 'audit-1',
  actorUserId: 'u-1',
  action: AdminAction.SUSPEND_CLINIC,
  targetType: 'Clinic',
  targetId: 'clinic-42',
  metadata: null,
  ip: null,
  userAgent: null,
  createdAt: new Date('2026-08-14T12:00:00Z'),
  actor: fakeActor,
};

const fakeResult: ListAuditResult = {
  items: [fakeItem],
  total: 1,
  page: 1,
  pageSize: 50,
};

// ─── tests ────────────────────────────────────────────────────────────────

describe('AdminAuditController', () => {
  let controller: AdminAuditController;
  let auditServiceMock: jest.Mocked<Pick<AdminAuditService, 'list'>>;

  beforeEach(() => {
    auditServiceMock = { list: jest.fn().mockResolvedValue(fakeResult) };
    controller = new AdminAuditController(
      auditServiceMock as unknown as AdminAuditService,
    );
  });

  describe('GET /admin/audit', () => {
    it('delega a auditService.list con los parámetros del DTO', async () => {
      const q: ListAuditQueryDto = {
        actorUserId: 'u-1',
        action: AdminAction.SUSPEND_CLINIC,
        targetType: 'Clinic',
        targetId: 'clinic-42',
        page: 2,
        pageSize: 25,
      };

      const result = await controller.list(q);

      expect(auditServiceMock.list).toHaveBeenCalledWith({
        actorUserId: 'u-1',
        action: AdminAction.SUSPEND_CLINIC,
        targetType: 'Clinic',
        targetId: 'clinic-42',
        page: 2,
        pageSize: 25,
      });
      expect(result).toBe(fakeResult);
    });

    it('pasa parámetros undefined cuando el DTO no los trae (sin filtros)', async () => {
      const q: ListAuditQueryDto = {};

      await controller.list(q);

      expect(auditServiceMock.list).toHaveBeenCalledWith({
        actorUserId: undefined,
        action: undefined,
        targetType: undefined,
        targetId: undefined,
        page: undefined,
        pageSize: undefined,
      });
    });

    it('retorna el resultado tal cual lo devuelve el service', async () => {
      const result = await controller.list({});
      expect(result).toEqual(fakeResult);
    });
  });

  describe('RolesGuard — protección de roles', () => {
    /**
     * Verificamos el guard directamente instanciándolo con un Reflector real.
     * El controller está decorado con @Roles('SUPERADMIN') a nivel de clase.
     */
    it('rechaza a CLINIC_ADMIN con ForbiddenException', () => {
      const reflector = new Reflector();
      const guard = new RolesGuard(reflector);

      // Simulamos que Reflector.getAllAndOverride devuelve ['SUPERADMIN']
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['SUPERADMIN']);

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({ user: { role: 'CLINIC_ADMIN' } }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as Parameters<typeof guard.canActivate>[0];

      expect(() => guard.canActivate(mockContext)).toThrow(ForbiddenException);
    });

    it('permite a SUPERADMIN', () => {
      const reflector = new Reflector();
      const guard = new RolesGuard(reflector);

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['SUPERADMIN']);

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({ user: { role: 'SUPERADMIN' } }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as Parameters<typeof guard.canActivate>[0];

      expect(guard.canActivate(mockContext)).toBe(true);
    });
  });
});
