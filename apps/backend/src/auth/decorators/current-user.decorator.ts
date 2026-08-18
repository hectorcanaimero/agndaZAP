import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * Contrato del objeto inyectado por `JwtStrategy.validate()` en `req.user`.
 * Es el subset mínimo que necesitan los controllers para tomar decisiones
 * multi-tenant / RBAC — SIN password ni PII innecesaria.
 *
 * `impersonatedBy` sólo aparece cuando el JWT fue emitido por el flujo
 * `POST /admin/clinics/:id/impersonate` (ver ADR 0014 §Impersonation).
 * Guarda el userId del SUPERADMIN original para trazabilidad; en tokens
 * normales queda `undefined`. Mantiene compatibilidad estructural con
 * la interfaz homónima de `tenant-context.util.ts`.
 */
export interface AuthUser {
  userId: string;
  clinicId: string | null;
  role: Role;
  impersonatedBy?: string;
}

/**
 * `@CurrentUser()` — extrae el user del JWT sin tocar `@Req()`.
 *
 * Uso:
 * ```ts
 * @Get('me')
 * me(@CurrentUser() user: AuthUser) { ... }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return req.user;
  },
);
