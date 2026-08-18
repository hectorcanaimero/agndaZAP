import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * TenantContext helpers — precondición del Bloque Panel (ver ADR 0005 §7,
 * refactorizada por ADR 0014 §Impersonation).
 *
 * Objetivo: centralizar la resolución del `clinicId` con el que se filtran
 * TODAS las queries del panel. Cualquier controller/service que consulte
 * datos scoped por clínica DEBE derivarse de acá.
 *
 * Reglas (post-ADR 0014):
 * - CLINIC_ADMIN / PROFESSIONAL: `clinicId` viene del JWT. Si no lo tiene,
 *   error de configuración → 403.
 * - SUPERADMIN: NO tiene acceso directo a data de clínicas. Para operar sobre
 *   una clínica específica debe pasar antes por el flujo de impersonation
 *   (`POST /admin/clinics/:id/impersonate`) que emite un JWT temporal con
 *   `clinicId` seteado + `impersonatedBy: <super-user-id>` (trazabilidad).
 *   El escape hatch viejo (SUPERADMIN + `?clinicId=` en query) fue eliminado
 *   por representar un riesgo de fuga cross-tenant en datos de salud.
 *
 * Sobre `overrideClinicId`: sigue existiendo por back-compat de callers, pero
 * ya no habilita ninguna capacidad extra:
 *  - Para NON-SUPERADMIN: si el override es distinto al `clinicId` del user,
 *    se rechaza con 403 (intento cross-tenant, accidental o hostil).
 *  - Para SUPERADMIN: si el override es distinto al `clinicId` del JWT
 *    impersonado, también se rechaza con 403 (impersonation activa manda).
 *  - Sin JWT impersonado, SUPERADMIN se corta en 400 antes de tocar DB.
 */
export interface AuthUser {
  userId: string;
  clinicId: string | null;
  role: Role;
  // Si presente, este JWT fue emitido por el flujo de impersonation del SUPERADMIN.
  // El userId original queda en `impersonatedBy` para trazabilidad.
  // Ver ADR 0014 §Impersonation.
  impersonatedBy?: string;
}

/**
 * Devuelve el `clinicId` de scope efectivo del user.
 *
 * Post-ADR 0014 el SUPERADMIN NO puede pasar clinicId por query string. Si
 * quiere operar sobre una clínica, tiene que hacer impersonation primero (que
 * emite un JWT con `clinicId` seteado + `impersonatedBy`). Sin JWT impersonado,
 * cualquier acceso a data de clínica se corta acá con 400.
 *
 * @throws BadRequestException si SUPERADMIN sin impersonation activa.
 * @throws ForbiddenException si CLINIC_ADMIN/PROFESSIONAL sin clinicId, o si
 *   intenta operar sobre otra clínica con override.
 */
export function assertClinicScope(
  user: AuthUser,
  overrideClinicId?: string,
): string {
  if (user.role === 'SUPERADMIN') {
    if (!user.clinicId) {
      throw new BadRequestException(
        'SUPERADMIN debe impersonar una clínica primero (ver /admin/clinics/:id/impersonate)',
      );
    }
    // Post-impersonation: el JWT trae clinicId. Cualquier override es sospechoso.
    if (overrideClinicId && overrideClinicId !== user.clinicId) {
      throw new ForbiddenException(
        'override clinicId no coincide con la impersonation activa',
      );
    }
    return user.clinicId;
  }
  // Non-SUPERADMIN: si viene un override distinto al clinicId del user, es un
  // intento (accidental o malicioso) de operar sobre otra clínica. 403.
  // Notar que con override IGUAL al del user, seguimos — no rompe callers.
  if (
    overrideClinicId &&
    overrideClinicId.length > 0 &&
    overrideClinicId !== user.clinicId
  ) {
    throw new ForbiddenException('no podés operar sobre otra clínica');
  }
  if (!user.clinicId) {
    // Usuario sin clínica y sin rol de SUPERADMIN → estado inválido (error de
    // seed / assignment). 403 explícito antes de tocar DB.
    throw new ForbiddenException('usuario sin clínica asignada');
  }
  return user.clinicId;
}

export function isSuperadmin(user: AuthUser): boolean {
  return user.role === 'SUPERADMIN';
}

/**
 * Fragment `where` estándar con `clinicId`.
 *
 * Uso obligatorio en TODAS las queries de los CRUDs del panel:
 *
 * ```ts
 * const services = await this.prisma.service.findMany({
 *   where: { ...tenantWhere(user, override), active: true },
 * });
 * ```
 *
 * Un ripgrep del código debe mostrar que NINGUNA query nueva escribe
 * `clinicId:` sin ir por este helper.
 *
 * Post-ADR 0014: el `overrideClinicId` sigue aceptándose por back-compat pero
 * ya no puede ampliar el scope — sólo puede coincidir con el clinicId del
 * user (o del JWT impersonado). Cualquier divergencia se rechaza.
 */
export function tenantWhere(
  user: AuthUser,
  overrideClinicId?: string,
): { clinicId: string } {
  return { clinicId: assertClinicScope(user, overrideClinicId) };
}
