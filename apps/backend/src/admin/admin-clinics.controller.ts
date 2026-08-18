import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminAction } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/tenant-context.util';
import { AdminAudit } from './admin-audit.decorator';
import { AdminAuditInterceptor } from './admin-audit.interceptor';
import {
  AdminClinicsService,
  type CreateClinicResult,
  type GetClinicResult,
  type ListClinicsResult,
} from './admin-clinics.service';
import { CreateClinicDto } from './dto/create-clinic.dto';
import { ListClinicsQueryDto } from './dto/list-clinics-query.dto';
import { SuspendClinicDto } from './dto/suspend-clinic.dto';
import { UpdateClinicDto } from './dto/update-clinic.dto';

/**
 * AdminClinicsController — CRUD de clínicas para el panel SaaS Admin.
 *
 * Sólo accesible a SUPERADMIN. El módulo es cross-tenant: no hay clinicId
 * en el JWT que restrinja el scope — por eso no usamos tenantWhere.
 *
 * `JwtAuthGuard` corre global (APP_GUARD en AuthModule). Acá sólo
 * necesitamos RolesGuard para verificar el rol por encima de la autenticación.
 *
 * El interceptor de auditoría se aplica a nivel controller pero los GETs
 * son ignorados por el propio interceptor (ver `MUTABLE_METHODS`).
 */
@Controller('admin/clinics')
@UseGuards(RolesGuard)
@Roles('SUPERADMIN')
@UseInterceptors(AdminAuditInterceptor)
export class AdminClinicsController {
  constructor(private readonly clinics: AdminClinicsService) {}

  /**
   * `POST /api/admin/clinics`
   *
   * Crea la clínica + primer CLINIC_ADMIN en una transacción atómica.
   * Retorna `{ id, clinic, admin }` — el interceptor usa `response.id`
   * como targetId para el trail de auditoría.
   */
  @Post()
  @AdminAudit({
    action: AdminAction.CREATE_CLINIC,
    targetType: 'Clinic',
    targetIdFrom: 'response.id',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateClinicDto,
  ): Promise<CreateClinicResult> {
    // `invitedByUserId` = super que dispara la creación. Se persiste en
    // `Invitation.invitedByUserId` para trazabilidad. La misma info queda
    // en `AdminAudit.actorUserId` — no es duplicación, son ejes distintos:
    // audit trail (todas las acciones) vs relación funcional de la invitación.
    return this.clinics.create({ ...dto, invitedByUserId: user.userId });
  }

  /**
   * `GET /api/admin/clinics?status=&search=&page=&pageSize=`
   *
   * Listado paginado. Defaults: page=1, pageSize=20.
   * Incluye `_count.professionals` y `_count.appointments` por item.
   */
  @Get()
  async list(@Query() q: ListClinicsQueryDto): Promise<ListClinicsResult> {
    return this.clinics.list({
      status: q.status,
      search: q.search,
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 20,
    });
  }

  /**
   * `GET /api/admin/clinics/:id`
   *
   * Detalle completo + métricas operativas de los últimos 30 días.
   */
  @Get(':id')
  async getOne(@Param('id') id: string): Promise<GetClinicResult> {
    return this.clinics.get(id);
  }

  /**
   * `PATCH /api/admin/clinics/:id`
   *
   * Edición parcial de `name`, `timezone`, `locale`, `address`.
   * `slug` y `wahaSession` son inmutables post-creación; `status` va por rutas dedicadas.
   */
  @Patch(':id')
  @AdminAudit({
    action: AdminAction.UPDATE_CLINIC,
    targetType: 'Clinic',
    targetIdFrom: 'params.id',
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateClinicDto,
  ): Promise<{ id: string }> {
    return this.clinics.update(id, dto);
  }

  /**
   * `POST /api/admin/clinics/:id/suspend`
   *
   * Suspende la clínica. 409 si ya estaba suspendida.
   */
  @Post(':id/suspend')
  @AdminAudit({
    action: AdminAction.SUSPEND_CLINIC,
    targetType: 'Clinic',
    targetIdFrom: 'params.id',
  })
  async suspend(
    @Param('id') id: string,
    @Body() dto: SuspendClinicDto,
  ): Promise<{ id: string }> {
    return this.clinics.suspend(id, dto.reason);
  }

  /**
   * `POST /api/admin/clinics/:id/reactivate`
   *
   * Reactiva una clínica suspendida. 409 si ya estaba activa.
   */
  @Post(':id/reactivate')
  @AdminAudit({
    action: AdminAction.REACTIVATE_CLINIC,
    targetType: 'Clinic',
    targetIdFrom: 'params.id',
  })
  async reactivate(@Param('id') id: string): Promise<{ id: string }> {
    return this.clinics.reactivate(id);
  }
}
