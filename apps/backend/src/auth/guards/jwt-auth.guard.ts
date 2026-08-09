import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * `JwtAuthGuard` — se registra como guard GLOBAL en `AuthModule` (via
 * `{ provide: APP_GUARD, useClass: JwtAuthGuard }`), así que TODAS las
 * rutas de la app quedan protegidas por default.
 *
 * Opt-out: cualquier ruta o controller marcado con `@Public()` corta acá
 * antes de invocar la estrategia `passport-jwt`.
 *
 * Racional del "deny by default": es imposible olvidarse de proteger un
 * endpoint nuevo — el default seguro es "requiere JWT". Cuando queremos
 * exponer algo (público, webhook), lo hacemos EXPLÍCITO con `@Public()`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // getAllAndOverride: mira PRIMERO el handler y después la clase; el más
    // específico gana. Esto permite marcar todo un controller como público
    // y desmarcar métodos concretos si hiciera falta.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
