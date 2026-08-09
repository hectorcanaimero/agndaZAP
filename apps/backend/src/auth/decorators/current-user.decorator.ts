import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * Contrato del objeto inyectado por `JwtStrategy.validate()` en `req.user`.
 * Es el subset mínimo que necesitan los controllers para tomar decisiones
 * multi-tenant / RBAC — SIN password ni PII innecesaria.
 */
export interface AuthUser {
  userId: string;
  clinicId: string | null;
  role: Role;
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
