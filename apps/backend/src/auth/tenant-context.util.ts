import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * TenantContext helpers — precondición del Bloque Panel (ver ADR 0005 §7).
 *
 * Objetivo: centralizar la resolución del `clinicId` con el que se filtran
 * TODAS las queries del panel. Cualquier controller/service que consulte
 * datos scoped por clínica DEBE derivarse de acá.
 *
 * Reglas:
 * - CLINIC_ADMIN / PROFESSIONAL: `clinicId` viene del JWT. Si no lo tiene,
 *   error de configuración → 403.
 * - SUPERADMIN: no tiene clínica propia. Necesita pasar `overrideClinicId`
 *   explícito (query param, header, body) para operar sobre una clínica
 *   específica. Sin él → 400. Esta fricción es intencional: forzamos al
 *   developer a decidir el scope en cada endpoint.
 *
 * Nota importante: `overrideClinicId` PROVIENE del request. NO se valida acá
 * que el string sea un clinicId real de la DB — eso es responsabilidad del
 * query siguiente (el findFirst con `where: { clinicId, id }` va a devolver
 * null si no existe, y el controller responde 404). Esta capa sólo blindea
 * el scope multi-tenant.
 */
export interface AuthUser {
  userId: string;
  clinicId: string | null;
  role: Role;
}

/**
 * Devuelve el `clinicId` de scope efectivo del user.
 *
 * @throws ForbiddenException si CLINIC_ADMIN/PROFESSIONAL no tiene `clinicId`.
 * @throws BadRequestException si SUPERADMIN no pasó `overrideClinicId`.
 */
export function assertClinicScope(
  user: AuthUser,
  overrideClinicId?: string,
): string {
  if (user.role === 'SUPERADMIN') {
    if (!overrideClinicId || overrideClinicId.length === 0) {
      throw new BadRequestException(
        'SUPERADMIN debe especificar clinicId explícito para acceder a datos de una clínica',
      );
    }
    return overrideClinicId;
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
 */
export function tenantWhere(
  user: AuthUser,
  overrideClinicId?: string,
): { clinicId: string } {
  return { clinicId: assertClinicScope(user, overrideClinicId) };
}
