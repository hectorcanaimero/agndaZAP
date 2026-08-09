import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  assertClinicScope,
  isSuperadmin,
  tenantWhere,
  type AuthUser,
} from './tenant-context.util';

/**
 * Tests del TenantContext (precondición del Bloque Panel).
 * Cubre la matriz completa: rol × clinicId × override.
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

  it('SUPERADMIN sin overrideClinicId → 400', () => {
    expect(() => assertClinicScope(superadmin)).toThrow(BadRequestException);
  });

  it('SUPERADMIN con overrideClinicId vacío → 400', () => {
    expect(() => assertClinicScope(superadmin, '')).toThrow(
      BadRequestException,
    );
  });

  it('SUPERADMIN con overrideClinicId válido → devuelve override', () => {
    expect(assertClinicScope(superadmin, 'clinic-Z')).toBe('clinic-Z');
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

  it('SUPERADMIN con override → devuelve override (sin cambios en la rama SUPERADMIN)', () => {
    expect(assertClinicScope(superadmin, 'clinic-Z')).toBe('clinic-Z');
  });
});

describe('isSuperadmin', () => {
  it('true para SUPERADMIN', () => {
    expect(
      isSuperadmin({ userId: 'x', clinicId: null, role: 'SUPERADMIN' }),
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

  it('SUPERADMIN con override → devuelve el override', () => {
    const user: AuthUser = {
      userId: 'u-super',
      clinicId: null,
      role: 'SUPERADMIN',
    };
    expect(tenantWhere(user, 'clinic-Z')).toEqual({ clinicId: 'clinic-Z' });
  });

  it('SUPERADMIN sin override → 400', () => {
    const user: AuthUser = {
      userId: 'u-super',
      clinicId: null,
      role: 'SUPERADMIN',
    };
    expect(() => tenantWhere(user)).toThrow(BadRequestException);
  });
});
