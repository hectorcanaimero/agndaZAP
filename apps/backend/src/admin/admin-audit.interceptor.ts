import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import type { MinimalRequest } from '../common/extract-ip';
import {
  ADMIN_AUDIT_KEY,
  type AdminAuditMeta,
} from './admin-audit.decorator';
import { AdminAuditService } from './admin-audit.service';

/** Métodos que implican mutación de estado — los únicos que persistimos. */
const MUTABLE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Interceptor de auditoría para el área SaaS Admin.
 *
 * Se aplica POR CONTROLLER (no global) con `@UseInterceptors(AdminAuditInterceptor)`,
 * para que los controllers de fases futuras opten explícitamente. Las GETs se
 * ignoran deliberadamente: read-only no deja rastro auditable, sólo un log debug.
 *
 * La auditoría ocurre DESPUÉS de que el handler resuelve con éxito; si el handler
 * falla, no se persiste nada. Esto previene registros de "acciones" que nunca
 * ocurrieron (falsos positivos en el trail).
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AdminAuditInterceptor');

  constructor(
    private readonly reflector: Reflector,
    private readonly adminAuditService: AdminAuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<
      MinimalRequest & {
        method: string;
        url: string;
        body?: Record<string, unknown>;
        user?: AuthUser;
      }
    >();
    const method = (req.method ?? '').toUpperCase();

    // GETs: sólo log debug, nunca persistir.
    if (!MUTABLE_METHODS.has(method)) {
      this.logger.debug(`[read] ${method} ${req.url} — sin auditar`);
      return next.handle();
    }

    const meta = this.reflector.get<AdminAuditMeta | undefined>(
      ADMIN_AUDIT_KEY,
      context.getHandler(),
    );

    // Sin decorador @AdminAudit → handler no registrado como auditable.
    if (!meta) {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        next: (response: unknown) => {
          // tap(next) sólo corre si el handler resolvió sin error.
          const actorUserId = req.user?.userId;
          if (!actorUserId) {
            // No debería llegar acá sin JWT válido, pero blindamos.
            this.logger.warn(`audit omitida — sin actorUserId en ${method} ${req.url}`);
            return;
          }

          const targetId = this.resolveTargetId(meta, req, response);
          if (!targetId) {
            this.logger.warn(
              `audit omitida — no se pudo resolver targetId (${meta.targetIdFrom}) en ${method} ${req.url}`,
            );
            return;
          }

          // Fire-and-forget: no bloqueamos la respuesta al cliente.
          // Si falla, queda en el log de error pero la operación ya fue exitosa.
          this.adminAuditService
            .logAction({
              actorUserId,
              action: meta.action,
              targetType: meta.targetType,
              targetId,
              ip: this.extractIp(req),
              userAgent: req.headers['user-agent'] as string | undefined,
            })
            .catch((err: unknown) => {
              this.logger.error(
                `fallo al persistir audit ${meta.action} target=${meta.targetType}:${targetId}`,
                err,
              );
            });
        },
      }),
    );
  }

  /**
   * Resuelve el targetId desde el origen declarado en el decorador.
   * Retorna `undefined` si la ruta no existe en el objeto esperado
   * (ej. handler que no devuelve `id` cuando se usa `response.id`).
   */
  private resolveTargetId(
    meta: AdminAuditMeta,
    req: MinimalRequest & { body?: Record<string, unknown> },
    response: unknown,
  ): string | undefined {
    switch (meta.targetIdFrom) {
      case 'params.id':
        return req.params?.['id'];
      case 'body.id':
        return req.body?.['id'] as string | undefined;
      case 'response.id':
        return (response as Record<string, unknown>)?.['id'] as string | undefined;
    }
  }

  /** Maneja el caso X-Forwarded-For (reverse proxy) antes de req.ip. */
  private extractIp(req: MinimalRequest): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : (forwarded as string).split(',')[0];
      return first?.trim();
    }
    return req.ip;
  }
}
