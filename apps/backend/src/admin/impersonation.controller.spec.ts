import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth/tenant-context.util';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ImpersonationController } from './impersonation.controller';
import type { ImpersonationService } from './impersonation.service';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

function makeReq(user: AuthUser | undefined) {
  return {
    user,
    headers: { 'user-agent': 'ShowlyAdmin/1.0' },
    ip: '203.0.113.7',
  };
}

function makeExecutionContext(
  user: AuthUser | undefined,
  handlerRoles: string[] | undefined = undefined,
): ExecutionContext {
  const handler = () => undefined;
  if (handlerRoles) {
    Reflect.defineMetadata(ROLES_KEY, handlerRoles, handler);
  }
  const cls = class Dummy {};
  return {
    switchToHttp: () => ({
      getRequest: () => makeReq(user),
      getResponse: () => ({}),
    }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

describe('ImpersonationController', () => {
  let impersonationSvc: Deep<ImpersonationService>;
  let controller: ImpersonationController;

  const superadmin: AuthUser = {
    userId: 'user-super-1',
    clinicId: null,
    role: 'SUPERADMIN',
  };
  const clinicAdmin: AuthUser = {
    userId: 'user-admin-1',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };
  const superadminAlreadyImpersonating: AuthUser = {
    userId: 'user-super-1',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN', // el JWT impersonado ya lo degradó
    impersonatedBy: 'user-super-1',
  };

  const okResult = {
    token: 'signed-jwt-abc',
    expiresAt: new Date('2026-08-14T12:30:00Z'),
    clinic: { id: 'clinic-Z', name: 'Clínica Zeta', slug: 'clinica-zeta' },
  };

  beforeEach(() => {
    impersonationSvc = {
      createImpersonationToken: jest.fn().mockResolvedValue(okResult),
    };
    controller = new ImpersonationController(
      impersonationSvc as unknown as ImpersonationService,
    );
  });

  describe('POST /admin/clinics/:id/impersonate — handler', () => {
    it('SUPERADMIN → llama al service con actor, targetClinicId, ip y userAgent', async () => {
      const req = {
        headers: { 'user-agent': 'ShowlyAdmin/1.0' },
        ip: '203.0.113.7',
      };
      const result = await controller.impersonate(superadmin, 'clinic-Z', req);

      expect(impersonationSvc.createImpersonationToken).toHaveBeenCalledTimes(1);
      const call = impersonationSvc.createImpersonationToken.mock.calls[0][0];
      expect(call.actorUserId).toBe('user-super-1');
      expect(call.targetClinicId).toBe('clinic-Z');
      expect(call.userAgent).toBe('ShowlyAdmin/1.0');
      // `ip` depende de `extractIp` — con TRUST_PROXY off (default) devuelve req.ip.
      expect(call.ip).toBe('203.0.113.7');
      expect(result).toEqual(okResult);
    });

    it('SUPERADMIN que YA está impersonando → 400 y NO llama al service (anti-nested)', async () => {
      const req = { headers: {}, ip: '203.0.113.7' };
      await expect(
        controller.impersonate(
          superadminAlreadyImpersonating,
          'clinic-Y',
          req,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(impersonationSvc.createImpersonationToken).not.toHaveBeenCalled();
    });

    it('mensaje del 400 pide salir primero (guía al usuario)', async () => {
      const req = { headers: {}, ip: '203.0.113.7' };
      await expect(
        controller.impersonate(
          superadminAlreadyImpersonating,
          'clinic-Y',
          req,
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('salí primero'),
      });
    });
  });

  describe('RolesGuard sobre POST /admin/clinics/:id/impersonate', () => {
    // El controller declara @Roles('SUPERADMIN'). Validamos que RolesGuard
    // corte a cualquier otro rol ANTES de llegar al handler.
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);

    it('SUPERADMIN pasa el guard', () => {
      const ctx = makeExecutionContext(superadmin, ['SUPERADMIN']);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('CLINIC_ADMIN → 403 (no puede iniciar impersonation)', () => {
      const ctx = makeExecutionContext(clinicAdmin, ['SUPERADMIN']);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('PROFESSIONAL → 403', () => {
      const ctx = makeExecutionContext(
        {
          userId: 'p',
          clinicId: 'clinic-A',
          role: 'PROFESSIONAL',
        },
        ['SUPERADMIN'],
      );
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('sin user en request → 403 (defensa en profundidad)', () => {
      const ctx = makeExecutionContext(undefined, ['SUPERADMIN']);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });
});
