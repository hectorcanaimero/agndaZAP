import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthUser } from '../decorators/current-user.decorator';

/**
 * `RolesGuard` — RBAC básico.
 *
 * Corre DESPUÉS del `JwtAuthGuard` (por eso `req.user` ya existe). Lee la
 * metadata `roles` puesta por `@Roles(...)` y compara con `user.role`.
 *
 * Reglas:
 * - Sin `@Roles(...)` → deja pasar. El chequeo de autenticación ya lo hizo JWT.
 * - Con roles y el user matchea → deja pasar.
 * - Con roles y NO matchea → 403 (NO 401: el user está autenticado, sólo no autorizado).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    if (!user) {
      // No debería pasar (JwtAuthGuard tira 401 antes), pero blindamos.
      throw new ForbiddenException('no autorizado');
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenException('rol insuficiente');
    }
    return true;
  }
}
