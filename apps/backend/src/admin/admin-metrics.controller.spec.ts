import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminMetricsController } from './admin-metrics.controller';
import type { AdminMetricsService, OverviewMetrics } from './admin-metrics.service';

// ─── fixtures ─────────────────────────────────────────────────────────────

const fakeOverview: OverviewMetrics = {
  clinics: { active: 10, suspended: 2, archived: 1, total: 13 },
  appointmentsLast30d: 133,
  noShowRateLast30d: 0.18,
  topClinics: [
    { id: 'c-1', name: 'Clínica 1', slug: 'clinica-1', appointmentCount: 50 },
    { id: 'c-2', name: 'Clínica 2', slug: 'clinica-2', appointmentCount: 40 },
  ],
};

// ─── tests ────────────────────────────────────────────────────────────────

describe('AdminMetricsController', () => {
  let controller: AdminMetricsController;
  let metricsServiceMock: jest.Mocked<Pick<AdminMetricsService, 'getOverview'>>;

  beforeEach(() => {
    metricsServiceMock = {
      getOverview: jest.fn().mockResolvedValue(fakeOverview),
    };
    controller = new AdminMetricsController(
      metricsServiceMock as unknown as AdminMetricsService,
    );
  });

  describe('GET /admin/metrics/overview', () => {
    it('delega a metricsService.getOverview sin parámetros', async () => {
      const result = await controller.getOverview();

      expect(metricsServiceMock.getOverview).toHaveBeenCalledTimes(1);
      expect(metricsServiceMock.getOverview).toHaveBeenCalledWith();
      expect(result).toBe(fakeOverview);
    });

    it('retorna la estructura completa con clinics, appointmentsLast30d, noShowRateLast30d y topClinics', async () => {
      const result = await controller.getOverview();

      expect(result).toHaveProperty('clinics');
      expect(result).toHaveProperty('appointmentsLast30d');
      expect(result).toHaveProperty('noShowRateLast30d');
      expect(result).toHaveProperty('topClinics');
      expect(result.clinics).toHaveProperty('active');
      expect(result.clinics).toHaveProperty('suspended');
      expect(result.clinics).toHaveProperty('archived');
      expect(result.clinics).toHaveProperty('total');
    });
  });

  describe('RolesGuard — protección de roles', () => {
    it('rechaza a CLINIC_ADMIN con ForbiddenException', () => {
      const reflector = new Reflector();
      const guard = new RolesGuard(reflector);

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

    it('usuario sin role → ForbiddenException', () => {
      const reflector = new Reflector();
      const guard = new RolesGuard(reflector);

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['SUPERADMIN']);

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({ user: { role: 'PROFESSIONAL' } }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as Parameters<typeof guard.canActivate>[0];

      expect(() => guard.canActivate(mockContext)).toThrow(ForbiddenException);
    });
  });
});
