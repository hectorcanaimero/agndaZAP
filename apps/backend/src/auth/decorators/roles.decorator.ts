import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * `@Roles('SUPERADMIN', ...)` — restringe una ruta a los roles listados.
 *
 * El `RolesGuard` lee esta metadata y compara contra `req.user.role`. Si el
 * decorator NO está presente, el guard deja pasar (el rol ya validó `JwtAuthGuard`).
 */
export const ROLES_KEY = 'roles';
export const Roles = (
  ...roles: Role[]
): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
