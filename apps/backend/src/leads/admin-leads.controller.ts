import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ListLeadsDto } from './dto/list-leads.dto';
import { LeadsService, type ListLeadsResult } from './leads.service';

/**
 * AdminLeadsController — listado de leads para el panel del owner.
 *
 * Vive en el mismo `LeadsModule` que el endpoint público (`POST /public/leads`),
 * pero es un controller SEPARADO porque el prefijo difiere:
 *   - Público: `POST /api/public/leads` (opta out del JwtAuthGuard con `@Public()`).
 *   - Admin:   `GET  /api/leads`         (protegido por Jwt + RolesGuard).
 *
 * Roles: sólo `SUPERADMIN`. Los leads son cross-tenant — no tienen `clinicId` —
 * así que no aplica `CLINIC_ADMIN` (un admin de una clínica no tiene por qué
 * ver los prospects de otras clínicas). Ver `docs/adr/` si se decide dar acceso
 * de auto-servicio a clínicas piloto en el futuro.
 *
 * `JwtAuthGuard` ya corre global (APP_GUARD en `AuthModule`), así que basta
 * con NO poner `@Public()` y agregar `RolesGuard` para que el rol se valide.
 */
@Controller('leads')
@UseGuards(RolesGuard)
@Roles('SUPERADMIN')
export class AdminLeadsController {
  constructor(private readonly leads: LeadsService) {}

  /**
   * `GET /api/leads?status=&page=&pageSize=`
   *
   * Filtro por status opcional. Paginación defensiva (page ≥1, pageSize 1..100)
   * — se valida en `ListLeadsDto` con class-validator.
   */
  @Get()
  async list(@Query() q: ListLeadsDto): Promise<ListLeadsResult> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    return this.leads.findAll({
      status: q.status,
      page,
      pageSize,
    });
  }
}
