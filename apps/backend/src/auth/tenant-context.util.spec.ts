import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  assertClinicScope,
  isSuperadmin,
  tenantWhere,
  type AuthUser,
} from './tenant-context.util';

/**
 * Tests del TenantContext (precondición del Bloque Panel, refactor ADR 0014).
 *
 * Post-ADR 0014 el SUPERADMIN NO puede resolver un clinicId pasando `?clinicId=`
 * por query string. El único camino válido es un JWT impersonado que ya trae
 * `clinicId` seteado + `impersonatedBy: <super-user-id>` para trazabilidad.
 *
 * Cubre la matriz completa: rol × clinicId × override × impersonation.
 */
describe('assertClinicScope', () => {
  const clinicAdmin: AuthUser = {
    userId: 'u1',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };
  const professional: AuthUser = {
    userId: 'u2',
    clinicId: 'clinic-A',
    role: 'PROFESSIONAL',
  };
  const superadmin: AuthUser = {
    userId: 'u-super',
    clinicId: null,
    role: 'SUPERADMIN',
  };
  const superadminImpersonating: AuthUser = {
    userId: 'u-super',
    clinicId: 'clinic-Z',
    role: 'SUPERADMIN',
    impersonatedBy: 'u-super',
  };
  const clinicAdminSinClinica: AuthUser = {
    userId: 'u3',
    clinicId: null,
    role: 'CLINIC_ADMIN',
  };

  it('CLINIC_ADMIN con clinicId → devuelve su clinicId', () => {
    expect(assertClinicScope(clinicAdmin)).toBe('clinic-A');
  });

  it('CLINIC_ADMIN sin clinicId → 403', () => {
    expect(() => assertClinicScope(clinicAdminSinClinica)).toThrow(
      ForbiddenException,
    );
  });

  it('PROFESSIONAL con clinicId → devuelve su clinicId', () => {
    expect(assertClinicScope(professional)).toBe('clinic-A');
  });

  it('SUPERADMIN sin impersonation activa → 400 (escape hatch eliminado)', () => {
    // Post-ADR 0014: SUPERADMIN sin `clinicId` en el JWT NO puede acceder a
    // data de clínica. Debe pasar por /admin/clinics/:id/impersonate primero.
    expect(() => assertClinicScope(superadmin)).toThrow(BadRequestException);
  });

  it('SUPERADMIN sin impersonation + override en query → 400 (el override ya NO habilita)', () => {
    // La ruta vieja "SUPERADMIN + ?clinicId=..." está cerrada. Aunque el caller
    // pase un override, sin impersonation activa se corta con 400. Esto es la
    // defensa central contra fugas cross-tenant en datos de salud.
    expect(() => assertClinicScope(superadmin, 'clinic-Z')).toThrow(
      BadRequestException,
    );
  });

  it('SUPERADMIN sin impersonation + override vacío → 400', () => {
    expect(() => assertClinicScope(superadmin, '')).toThrow(
      BadRequestException,
    );
  });

  it('SUPERADMIN impersonando (JWT con clinicId) → devuelve el clinicId del JWT', () => {
    expect(assertClinicScope(superadminImpersonating)).toBe('clinic-Z');
  });

  it('SUPERADMIN impersonando + override IGUAL al JWT → devuelve el clinicId (no rompe callers)', () => {
    expect(assertClinicScope(superadminImpersonating, 'clinic-Z')).toBe(
      'clinic-Z',
    );
  });

  it('SUPERADMIN impersonando + override DIVERGENTE → 403 (impersonation activa manda)', () => {
    // Si el JWT dice clinic-Z pero el caller pasa ?clinicId=clinic-Y, algo
    // está mal: o el caller intenta escapar del scope de impersonation o hay
    // un bug. Corte en 403.
    expect(() =>
      assertClinicScope(superadminImpersonating, 'clinic-Y'),
    ).toThrow(ForbiddenException);
  });

  it('CLINIC_ADMIN con override DIVERGENTE → 403 (no se ignora silenciosamente)', () => {
    // Antes devolvía el clinicId del user tapando el override. Ahora tiramos
    // 403 explícito para señalizar el intento cross-tenant. Un ?clinicId=
    // ajeno es un bug del caller o un intento hostil — no queremos que se
    // silencie.
    expect(() => assertClinicScope(clinicAdmin, 'clinic-Z')).toThrow(
      ForbiddenException,
    );
  });

  it('CLINIC_ADMIN con override IGUAL al suyo → devuelve su clinicId (no rompe callers)', () => {
    expect(assertClinicScope(clinicAdmin, 'clinic-A')).toBe('clinic-A');
  });

  it('CLINIC_ADMIN sin override → devuelve su clinicId (comportamiento base)', () => {
    expect(assertClinicScope(clinicAdmin)).toBe('clinic-A');
  });
});

describe('isSuperadmin', () => {
  it('true para SUPERADMIN', () => {
    expect(
      isSuperadmin({ userId: 'x', clinicId: null, role: 'SUPERADMIN' }),
    ).toBe(true);
  });

  it('true para SUPERADMIN impersonando (rol sigue siendo SUPERADMIN)', () => {
    expect(
      isSuperadmin({
        userId: 'x',
        clinicId: 'clinic-A',
        role: 'SUPERADMIN',
        impersonatedBy: 'x',
      }),
    ).toBe(true);
  });

  it('false para CLINIC_ADMIN', () => {
    expect(
      isSuperadmin({ userId: 'x', clinicId: 'c', role: 'CLINIC_ADMIN' }),
    ).toBe(false);
  });

  it('false para PROFESSIONAL', () => {
    expect(
      isSuperadmin({ userId: 'x', clinicId: 'c', role: 'PROFESSIONAL' }),
    ).toBe(false);
  });
});

describe('tenantWhere', () => {
  it('devuelve { clinicId } con el scope resuelto', () => {
    const user: AuthUser = {
      userId: 'u1',
      clinicId: 'clinic-A',
      role: 'CLINIC_ADMIN',
    };
    expect(tenantWhere(user)).toEqual({ clinicId: 'clinic-A' });
  });

  it('SUPERADMIN impersonando → devuelve el clinicId del JWT', () => {
    const user: AuthUser = {
      userId: 'u-super',
      clinicId: 'clinic-Z',
      role: 'SUPERADMIN',
      impersonatedBy: 'u-super',
    };
    expect(tenantWhere(user)).toEqual({ clinicId: 'clinic-Z' });
  });

  it('SUPERADMIN sin impersonation → 400 (aunque venga override)', () => {
    const user: AuthUser = {
      userId: 'u-super',
      clinicId: null,
      role: 'SUPERADMIN',
    };
    expect(() => tenantWhere(user)).toThrow(BadRequestException);
    expect(() => tenantWhere(user, 'clinic-Z')).toThrow(BadRequestException);
  });
});
