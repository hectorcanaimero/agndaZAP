import { randomUUID } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { requestContext, RequestContextData } from './request-context';

// Datos que Passport-jwt inyecta en `req.user` tras el JwtAuthGuard.
// Coincide con el shape emitido por JwtStrategy.validate().
type AuthenticatedUser = {
  userId: string;
  clinicId?: string;
  impersonatedBy?: string;
  role?: string;
};

// Populates `requestContext` (AsyncLocalStorage) con requestId + user data.
// Corre DESPUÉS del JwtAuthGuard (los interceptors corren después de guards)
// — indispensable para acceder a `req.user`.
//
// Alternativa evaluada: middleware. Descartada porque los middlewares corren
// ANTES de guards, y no tendrían `req.user`.
//
// El requestId ya lo generó `pino-http` via `genReqId` en logger.config.ts;
// acá solo lo consumimos. Fallback: si por algún motivo no está (endpoint
// que no pasa por el pipeline HTTP normal), generamos uno nuevo.
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Solo aplicamos a requests HTTP — GraphQL/RPC/WS no cargan `req` normal.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<{
      id?: string;
      user?: AuthenticatedUser;
      headers: Record<string, string | string[] | undefined>;
    }>();

    // Prioridad para el requestId:
    // 1. `req.id` de pino-http (que ya honró x-request-id header)
    // 2. Header x-request-id directo (si pino-http no corrió)
    // 3. randomUUID fallback
    const requestId =
      req.id ??
      (typeof req.headers['x-request-id'] === 'string'
        ? (req.headers['x-request-id'] as string)
        : undefined) ??
      randomUUID();

    const store: RequestContextData = { requestId };
    if (req.user?.clinicId) store.clinicId = req.user.clinicId;
    if (req.user?.userId) store.userId = req.user.userId;
    if (req.user?.impersonatedBy) {
      store.impersonatedBy = req.user.impersonatedBy;
    }

    // Wrap el flujo Observable dentro de `als.run(store, ...)` — cualquier
    // async operation downstream (services, Prisma, waha calls) hereda el
    // contexto. La suscripción se hace desde adentro para que el
    // subscribe callback también viva en el scope del ALS.
    return new Observable((subscriber) => {
      requestContext.run(store, () => {
        const inner = next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
        return () => inner.unsubscribe();
      });
    });
  }
}
