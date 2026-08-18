import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminAuditService, type ListAuditResult } from './admin-audit.service';
import { ListAuditQueryDto } from './dto/list-audit-query.dto';

/**
 * AdminAuditController — trail de auditoría SaaS (read-only).
 *
 * `GET /api/admin/audit` — listado paginado de acciones administrativas.
 *
 * No se aplica `AdminAuditInterceptor` porque este controller es GET-only:
 * leer el trail no genera un registro de auditoría propio (el interceptor ya
 * filtra sólo POST/PATCH/DELETE).
 *
 * Rol requerido: SUPERADMIN.
 */
@Controller('admin/audit')
@UseGuards(RolesGuard)
@Roles('SUPERADMIN')
export class AdminAuditController {
  constructor(private readonly auditService: AdminAuditService) {}

  /**
   * `GET /api/admin/audit`
   *
   * Filtros opcionales: actorUserId, action, targetType, targetId.
   * Paginación: page (default 1), pageSize (default 50, max 200).
   * Orden: createdAt desc (más reciente primero).
   */
  @Get()
  list(@Query() q: ListAuditQueryDto): Promise<ListAuditResult> {
    return this.auditService.list({
      actorUserId: q.actorUserId,
      action: q.action,
      targetType: q.targetType,
      targetId: q.targetId,
      page: q.page,
      pageSize: q.pageSize,
    });
  }
}
