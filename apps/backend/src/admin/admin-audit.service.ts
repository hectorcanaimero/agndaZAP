import { Injectable, Logger } from '@nestjs/common';
import type { AdminAudit, User } from '@prisma/client';
import { AdminAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface LogActionInput {
  actorUserId: string;
  action: AdminAction;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  // Presente solo cuando la acción se ejecuta bajo impersonation (ver ADR 0016).
  // El interceptor lo popula desde `req.user.impersonatedBy`.
  impersonatedBy?: string;
}

export interface ListAuditInput {
  actorUserId?: string;
  action?: AdminAction;
  targetType?: string;
  targetId?: string;
  page?: number;
  pageSize?: number;
}

type AuditWithActor = AdminAudit & {
  actor: Pick<User, 'id' | 'email' | 'name'>;
};

export interface ListAuditResult {
  items: AuditWithActor[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Capa de persistencia para el trail de auditoría SaaS.
 *
 * Intencionalmente delgada: no toma decisiones de negocio, sólo escribe.
 * Las decisiones de QUÉ auditar y CUÁNDO viven en `AdminAuditInterceptor`
 * y en los decoradores `@AdminAudit(...)` de cada handler.
 *
 * AdminAudit es cross-tenant — NO lleva clinicId porque el SUPERADMIN actúa
 * SOBRE tenants, no pertenece a uno. Ver schema.prisma para el modelo completo.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger('AdminAuditService');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persiste una acción administrativa con todos sus metadatos contextuales.
   * Loguea en stdout para que los agregadores de logs puedan correlacionar
   * la traza sin necesidad de consultar la DB.
   */
  async logAction(input: LogActionInput): Promise<AdminAudit> {
    const record = await this.prisma.adminAudit.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: (input.metadata as Prisma.InputJsonValue) ?? undefined,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        impersonatedBy: input.impersonatedBy ?? null,
      },
    });

    // Log en stdout (Axiom) con impersonatedBy visible para correlación —
    // permite grep tipo "audit impersonatedBy=super-1" incluso si la DB
    // se atrasa o el row se pierde por un bug futuro.
    const impersonationTag = record.impersonatedBy
      ? ` impersonatedBy=${record.impersonatedBy}`
      : '';
    this.logger.log(
      `audit id=${record.id} action=${record.action} actor=${record.actorUserId}` +
        `${impersonationTag} target=${record.targetType}:${record.targetId}`,
    );

    return record;
  }

  /**
   * Listado paginado del trail de auditoría, con filtros opcionales.
   *
   * Todos los filtros son aditivos (AND). Ordenado por `createdAt desc` para
   * que lo más reciente aparezca primero en el panel de auditoría.
   *
   * pageSize se capa a 200 para evitar scans grandes desde el browser.
   */
  async list(input: ListAuditInput): Promise<ListAuditResult> {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50));
    const skip = (page - 1) * pageSize;

    const where: Prisma.AdminAuditWhereInput = {};
    if (input.actorUserId) where.actorUserId = input.actorUserId;
    if (input.action) where.action = input.action;
    if (input.targetType) where.targetType = input.targetType;
    if (input.targetId) where.targetId = input.targetId;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.adminAudit.findMany({
        where,
        include: {
          actor: { select: { id: true, email: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.adminAudit.count({ where }),
    ]);

    return { items: items as AuditWithActor[], total, page, pageSize };
  }
}
