import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminAction } from '@prisma/client';
import { Observable, from, mergeMap, of } from 'rxjs';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { extractIp, type MinimalRequest } from '../common/extract-ip';
import {
  ADMIN_AUDIT_KEY,
  type AdminAuditMeta,
} from './admin-audit.decorator';
import { AdminAuditService } from './admin-audit.service';

/** Métodos que implican mutación de estado — los únicos que persistimos. */
const MUTABLE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Mapa path→targetType. Se resuelve desde `req.route?.path` (patrón del
 * handler, ej. `/api/patients/:id`) y matchea el primer segmento después
 * de `/api/`. Extensible: agregar entries acá al sumar nuevos módulos.
 */
const PATH_TO_TARGET_TYPE: Array<{ prefix: string; targetType: string }> = [
  { prefix: '/api/patients', targetType: 'Patient' },
  { prefix: '/api/appointments', targetType: 'Appointment' },
  { prefix: '/api/conversations', targetType: 'Conversation' },
  { prefix: '/api/services', targetType: 'Service' },
  { prefix: '/api/professionals', targetType: 'Professional' },
  { prefix: '/api/business-hours', targetType: 'BusinessHours' },
  { prefix: '/api/time-off', targetType: 'TimeOff' },
  { prefix: '/api/clinics', targetType: 'Clinic' },
  { prefix: '/api/faq', targetType: 'Faq' },
  { prefix: '/api/feedback', targetType: 'Feedback' },
];

/**
 * Interceptor de auditoría — GLOBAL (registrado como APP_INTERCEPTOR).
 *
 * Lógica dual (ver ADR 0016):
 *
 * 1. **Impersonation activa** (`user.impersonatedBy` presente + mutation):
 *    audita SIEMPRE con action `IMPERSONATED_WRITE`, independientemente de
 *    si hay decorador `@AdminAudit()`. Cubre TODOS los endpoints del panel
 *    sin cambiar controllers. Cierra hallazgo Alto #1 del review de seguridad.
 *
 * 2. **Sin impersonation + decorador presente**: audita con la meta del
 *    decorador (backward compat con `AdminClinicsController`).
 *
 * 3. **Cualquier otro caso**: skip (mutations normales de CLINIC_ADMIN no
 *    generan ruido en el trail).
 *
 * GETs se ignoran siempre.
 *
 * Persistencia: `await` bloqueante. Si el INSERT falla, log a stderr +
 * Sentry lo captura via SentryFilter — pero NO tira 500 al cliente
 * (la mutation original ya se ejecutó, tirar 500 sería peor).
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AdminAuditInterceptor');
  private readonly trustProxy = process.env.TRUST_PROXY === 'true';

  constructor(
    private readonly reflector: Reflector,
    private readonly adminAuditService: AdminAuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<
      MinimalRequest & {
        method?: string;
        url?: string;
        route?: { path?: string };
        body?: Record<string, unknown>;
        user?: AuthUser;
      }
    >();
    const method = (req.method ?? '').toUpperCase();

    // GET/HEAD/OPTIONS nunca dejan trail.
    if (!MUTABLE_METHODS.has(method)) {
      return next.handle();
    }

    const user = req.user;
    if (!user) {
      // Sin JWT válido no hay actor identificable — no auditamos endpoints
      // públicos. Los request de leads/webhooks tienen sus propios logs.
      return next.handle();
    }

    // Rama 1: mutation bajo impersonation → audit SIEMPRE.
    if (user.impersonatedBy) {
      return this.wrapWithImpersonationAudit(next.handle(), req, user);
    }

    // Rama 2: mutation normal — audit solo si hay decorador.
    const meta = this.reflector.get<AdminAuditMeta | undefined>(
      ADMIN_AUDIT_KEY,
      context.getHandler(),
    );
    if (meta) {
      return this.wrapWithDecoratorAudit(next.handle(), req, user, meta);
    }

    return next.handle();
  }

  // ── Rama 1: impersonation ────────────────────────────────────────────

  private wrapWithImpersonationAudit(
    source: Observable<unknown>,
    req: MinimalRequest & {
      method?: string;
      url?: string;
      route?: { path?: string };
      user?: AuthUser;
    },
    user: AuthUser,
  ): Observable<unknown> {
    return source.pipe(
      mergeMap((response) =>
        from(this.persistImpersonationAudit(req, user)).pipe(
          mergeMap(() => of(response)),
        ),
      ),
    );
  }

  private async persistImpersonationAudit(
    req: MinimalRequest & {
      method?: string;
      url?: string;
      route?: { path?: string };
    },
    user: AuthUser,
  ): Promise<void> {
    const path = req.route?.path ?? req.url ?? '';
    const targetType = this.inferTargetType(path);
    const targetId = req.params?.['id'] ?? '?';

    try {
      await this.adminAuditService.logAction({
        actorUserId: user.userId,
        impersonatedBy: user.impersonatedBy,
        action: AdminAction.IMPERSONATED_WRITE,
        targetType,
        targetId,
        metadata: {
          method: (req.method ?? '').toUpperCase(),
          path,
          clinicId: user.clinicId ?? null,
        },
        ip: extractIp(req, this.trustProxy),
        userAgent: this.userAgent(req),
      });
    } catch (err) {
      // Await bloqueante pero NO throw: la mutation original ya se ejecutó,
      // tirar 500 acá dejaría al cliente en estado ambiguo (¿se guardó o no?).
      // El fallo queda en stdout (Axiom) + Sentry lo captura por level=error.
      this.logger.error(
        `AUDIT_FAILED impersonation actor=${user.userId} impersonatedBy=${user.impersonatedBy} target=${targetType}:${targetId} — trail comprometido, revisar Postgres. err=${(err as Error).message}`,
      );
    }
  }

  private inferTargetType(path: string): string {
    for (const entry of PATH_TO_TARGET_TYPE) {
      if (path.startsWith(entry.prefix)) return entry.targetType;
    }
    return 'Unknown';
  }

  // ── Rama 2: decorador (backward compat) ──────────────────────────────

  private wrapWithDecoratorAudit(
    source: Observable<unknown>,
    req: MinimalRequest & { body?: Record<string, unknown>; user?: AuthUser },
    user: AuthUser,
    meta: AdminAuditMeta,
  ): Observable<unknown> {
    return source.pipe(
      mergeMap((response) =>
        from(this.persistDecoratorAudit(req, user, meta, response)).pipe(
          mergeMap(() => of(response)),
        ),
      ),
    );
  }

  private async persistDecoratorAudit(
    req: MinimalRequest & { body?: Record<string, unknown> },
    user: AuthUser,
    meta: AdminAuditMeta,
    response: unknown,
  ): Promise<void> {
    const targetId = this.resolveTargetId(meta, req, response);
    if (!targetId) {
      this.logger.warn(
        `audit omitida — no se pudo resolver targetId (${meta.targetIdFrom}) para ${meta.action}`,
      );
      return;
    }

    try {
      await this.adminAuditService.logAction({
        actorUserId: user.userId,
        impersonatedBy: user.impersonatedBy, // undefined en rama 2 por diseño
        action: meta.action,
        targetType: meta.targetType,
        targetId,
        ip: extractIp(req, this.trustProxy),
        userAgent: this.userAgent(req),
      });
    } catch (err) {
      this.logger.error(
        `AUDIT_FAILED decorator actor=${user.userId} action=${meta.action} target=${meta.targetType}:${targetId} — err=${(err as Error).message}`,
      );
    }
  }

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

  // ── Utils ─────────────────────────────────────────────────────────────

  private userAgent(req: MinimalRequest): string | undefined {
    const ua = req.headers['user-agent'];
    return Array.isArray(ua) ? ua[0] : (ua as string | undefined);
  }
}
