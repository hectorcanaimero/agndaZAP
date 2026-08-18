import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminAction } from '@prisma/client';
import { firstValueFrom, of } from 'rxjs';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { ADMIN_AUDIT_KEY, type AdminAuditMeta } from './admin-audit.decorator';
import { AdminAuditInterceptor } from './admin-audit.interceptor';
import type { AdminAuditService, LogActionInput } from './admin-audit.service';

// Helper: construye un ExecutionContext HTTP mínimo. `handler` es la función
// del controller (para el reflector.get de la meta del decorador).
function mockContext(
  req: Record<string, unknown>,
  handler: () => unknown = () => undefined,
): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function makeNext(response: unknown = { id: 'ok' }): CallHandler {
  return { handle: () => of(response) };
}

describe('AdminAuditInterceptor', () => {
  let interceptor: AdminAuditInterceptor;
  let auditService: jest.Mocked<Pick<AdminAuditService, 'logAction'>>;
  let reflector: Reflector;

  beforeEach(() => {
    auditService = { logAction: jest.fn().mockResolvedValue({ id: 'audit-x' }) };
    reflector = new Reflector();
    interceptor = new AdminAuditInterceptor(
      reflector,
      auditService as unknown as AdminAuditService,
    );
  });

  // ─────────────── Skips ───────────────

  it('GET → skip (no audita)', async () => {
    const req = { method: 'GET', url: '/api/patients/x', user: { userId: 'u-1' } };
    await firstValueFrom(interceptor.intercept(mockContext(req), makeNext()));
    expect(auditService.logAction).not.toHaveBeenCalled();
  });

  it('mutation SIN req.user → skip', async () => {
    const req = { method: 'PATCH', url: '/api/patients/x', headers: {} };
    await firstValueFrom(interceptor.intercept(mockContext(req), makeNext()));
    expect(auditService.logAction).not.toHaveBeenCalled();
  });

  it('mutation con user pero SIN impersonatedBy y SIN decorador → skip', async () => {
    const req = {
      method: 'PATCH',
      url: '/api/patients/xxx',
      headers: {},
      user: { userId: 'clinic-admin-1', clinicId: 'clinic-1', role: 'CLINIC_ADMIN' },
    };
    await firstValueFrom(interceptor.intercept(mockContext(req), makeNext()));
    expect(auditService.logAction).not.toHaveBeenCalled();
  });

  it('contexto no-HTTP (rpc, ws) → skip', async () => {
    const nonHttp = { getType: () => 'rpc' } as unknown as ExecutionContext;
    const value = await firstValueFrom(interceptor.intercept(nonHttp, makeNext('rpc-ok')));
    expect(value).toBe('rpc-ok');
    expect(auditService.logAction).not.toHaveBeenCalled();
  });

  // ─────────────── Rama 1: impersonation ───────────────

  it('PATCH bajo impersonation → audita SIEMPRE con IMPERSONATED_WRITE', async () => {
    const req = {
      method: 'PATCH',
      url: '/api/patients/patient-abc',
      route: { path: '/api/patients/:id' },
      params: { id: 'patient-abc' },
      headers: { 'user-agent': 'Mozilla/5.0' },
      user: {
        userId: 'super-1',
        clinicId: 'clinic-target',
        impersonatedBy: 'super-1',
        role: 'CLINIC_ADMIN',
      } as AuthUser,
    };

    await firstValueFrom(interceptor.intercept(mockContext(req), makeNext()));

    expect(auditService.logAction).toHaveBeenCalledTimes(1);
    const input = auditService.logAction.mock.calls[0][0] as LogActionInput;
    expect(input.actorUserId).toBe('super-1');
    expect(input.impersonatedBy).toBe('super-1');
    expect(input.action).toBe(AdminAction.IMPERSONATED_WRITE);
    expect(input.targetType).toBe('Patient');
    expect(input.targetId).toBe('patient-abc');
    expect(input.metadata).toEqual({
      method: 'PATCH',
      path: '/api/patients/:id',
      clinicId: 'clinic-target',
    });
    expect(input.userAgent).toBe('Mozilla/5.0');
  });

  it('infiere targetType correctamente para varios paths', async () => {
    const cases = [
      { path: '/api/appointments/xxx/status', expected: 'Appointment' },
      { path: '/api/conversations/xxx/reply', expected: 'Conversation' },
      { path: '/api/services/xxx', expected: 'Service' },
      { path: '/api/professionals/xxx', expected: 'Professional' },
      { path: '/api/business-hours/xxx', expected: 'BusinessHours' },
      { path: '/api/time-off/xxx', expected: 'TimeOff' },
      { path: '/api/faq/xxx', expected: 'Faq' },
      { path: '/api/unknown-thing/xxx', expected: 'Unknown' },
    ];

    for (const c of cases) {
      auditService.logAction.mockClear();
      const req = {
        method: 'PATCH',
        url: c.path,
        route: { path: c.path },
        params: { id: 'xxx' },
        headers: {},
        user: {
          userId: 'super-1',
          clinicId: 'c-1',
          impersonatedBy: 'super-1',
          role: 'CLINIC_ADMIN',
        } as AuthUser,
      };
      await firstValueFrom(interceptor.intercept(mockContext(req), makeNext()));
      const input = auditService.logAction.mock.calls[0][0] as LogActionInput;
      expect(input.targetType).toBe(c.expected);
    }
  });

  it('POST bajo impersonation SIN params.id → targetId="?"', async () => {
    const req = {
      method: 'POST',
      url: '/api/appointments',
      route: { path: '/api/appointments' },
      headers: {},
      user: {
        userId: 'super-1',
        clinicId: 'c-1',
        impersonatedBy: 'super-1',
        role: 'CLINIC_ADMIN',
      } as AuthUser,
    };
    await firstValueFrom(interceptor.intercept(mockContext(req), makeNext({ id: 'new-appt' })));
    const input = auditService.logAction.mock.calls[0][0] as LogActionInput;
    expect(input.targetId).toBe('?');
  });

  // ─────────────── Rama 2: decorador backward compat ───────────────

  it('mutation SIN impersonation pero CON @AdminAudit → audita con meta del decorador', async () => {
    const meta: AdminAuditMeta = {
      action: AdminAction.SUSPEND_CLINIC,
      targetType: 'Clinic',
      targetIdFrom: 'params.id',
    };
    const handler = () => undefined;
    Reflect.defineMetadata(ADMIN_AUDIT_KEY, meta, handler);

    const req = {
      method: 'PATCH',
      url: '/api/admin/clinics/clinic-xxx/suspend',
      params: { id: 'clinic-xxx' },
      headers: {},
      user: { userId: 'super-1', role: 'SUPERADMIN' } as AuthUser,
    };

    await firstValueFrom(interceptor.intercept(mockContext(req, handler), makeNext()));

    expect(auditService.logAction).toHaveBeenCalledTimes(1);
    const input = auditService.logAction.mock.calls[0][0] as LogActionInput;
    expect(input.action).toBe(AdminAction.SUSPEND_CLINIC);
    expect(input.targetType).toBe('Clinic');
    expect(input.targetId).toBe('clinic-xxx');
    expect(input.impersonatedBy).toBeUndefined();
  });

  // ─────────────── Rama 3: audit failure ───────────────

  it('audit failure NO tira 500 (mutation ya se ejecutó)', async () => {
    auditService.logAction.mockRejectedValueOnce(new Error('DB down'));
    const req = {
      method: 'PATCH',
      url: '/api/patients/x',
      route: { path: '/api/patients/:id' },
      params: { id: 'x' },
      headers: {},
      user: {
        userId: 'super-1',
        clinicId: 'c-1',
        impersonatedBy: 'super-1',
        role: 'CLINIC_ADMIN',
      } as AuthUser,
    };

    // Debe resolver con el response del handler, NO tirar excepción.
    const value = await firstValueFrom(
      interceptor.intercept(mockContext(req), makeNext({ ok: true })),
    );
    expect(value).toEqual({ ok: true });
    expect(auditService.logAction).toHaveBeenCalledTimes(1);
  });

  // ─────────────── extractIp respetando TRUST_PROXY ───────────────

  it('extractIp usa X-Forwarded-For solo si TRUST_PROXY=true', async () => {
    const originalTrust = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'true';
    // Necesitamos re-instanciar para que el constructor lea el nuevo env.
    const interceptorWithProxy = new AdminAuditInterceptor(
      reflector,
      auditService as unknown as AdminAuditService,
    );

    try {
      const req = {
        method: 'PATCH',
        url: '/api/patients/x',
        route: { path: '/api/patients/:id' },
        params: { id: 'x' },
        headers: { 'x-forwarded-for': '8.8.8.8' },
        user: {
          userId: 'super-1',
          clinicId: 'c-1',
          impersonatedBy: 'super-1',
          role: 'CLINIC_ADMIN',
        } as AuthUser,
      };

      await firstValueFrom(interceptorWithProxy.intercept(mockContext(req), makeNext()));
      const input = auditService.logAction.mock.calls[0][0] as LogActionInput;
      expect(input.ip).toBe('8.8.8.8');
    } finally {
      process.env.TRUST_PROXY = originalTrust;
    }
  });

  it('extractIp IGNORA X-Forwarded-For cuando TRUST_PROXY=false', async () => {
    const prev = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'false';
    const noProxy = new AdminAuditInterceptor(
      reflector,
      auditService as unknown as AdminAuditService,
    );

    try {
      const req = {
        method: 'PATCH',
        url: '/api/patients/x',
        route: { path: '/api/patients/:id' },
        params: { id: 'x' },
        ip: '10.0.0.5',
        headers: { 'x-forwarded-for': '8.8.8.8' },
        user: {
          userId: 'super-1',
          clinicId: 'c-1',
          impersonatedBy: 'super-1',
          role: 'CLINIC_ADMIN',
        } as AuthUser,
      };

      await firstValueFrom(noProxy.intercept(mockContext(req), makeNext()));
      const input = auditService.logAction.mock.calls[0][0] as LogActionInput;
      // TRUST_PROXY=false → usa req.ip directamente, ignora el header spoofeado.
      expect(input.ip).toBe('10.0.0.5');
    } finally {
      process.env.TRUST_PROXY = prev;
    }
  });
});
