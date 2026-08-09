import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

/**
 * CRUD de `Service` para el Panel.
 *
 * Reglas duras:
 * - Multi-tenant: TODAS las queries pasan por `tenantWhere(user, clinicId?)`.
 *   El param `?clinicId=` sólo se respeta si el user es SUPERADMIN (lo maneja
 *   `assertClinicScope` internamente).
 * - Soft-delete: `DELETE` marca `active = false`. Nunca borra fila para no
 *   romper citas históricas (Appointment.serviceId FK).
 */
@Controller('services')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class ServicesController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Valida que todos los `professionalIds` pertenecen a la misma clínica del
   * scope. Sin este check, Prisma `connect` linkearía profesionales de otras
   * clínicas — cross-tenant leak en el grafo M-N (audit B1).
   */
  private async assertProfessionalsInScope(
    ids: string[],
    clinicId: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.prisma.professional.findMany({
      where: { id: { in: ids }, clinicId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException(
        'algún professionalId no pertenece a esta clínica',
      );
    }
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateServiceDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    if (dto.professionalIds && dto.professionalIds.length > 0) {
      await this.assertProfessionalsInScope(
        dto.professionalIds,
        scope.clinicId,
      );
    }
    return this.prisma.service.create({
      data: {
        clinicId: scope.clinicId,
        name: dto.name,
        durationMin: dto.durationMin,
        bufferMin: dto.bufferMin ?? 0,
        priceCents: dto.priceCents ?? null,
        active: true,
        ...(dto.professionalIds && dto.professionalIds.length > 0
          ? {
              professionals: {
                // Pre-validado arriba: sólo IDs del mismo tenant llegan acá.
                connect: dto.professionalIds.map((id) => ({ id })),
              },
            }
          : {}),
      },
    });
  }

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    return this.prisma.service.findMany({
      where: { ...tenantWhere(user, clinicIdOverride), active: true },
      orderBy: { name: 'asc' },
      include: {
        professionals: { select: { id: true, name: true } },
      },
    });
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const svc = await this.prisma.service.findFirst({
      where: { id, ...tenantWhere(user, clinicIdOverride) },
      include: {
        professionals: { select: { id: true, name: true } },
      },
    });
    if (!svc) throw new NotFoundException('servicio no encontrado');
    return svc;
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateServiceDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    // Verificamos primero que el servicio pertenece al tenant. Sin este check,
    // `update` con only-by-id filtraría entre clínicas.
    const scope = tenantWhere(user, clinicIdOverride);
    const existing = await this.prisma.service.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('servicio no encontrado');

    if (dto.professionalIds && dto.professionalIds.length > 0) {
      await this.assertProfessionalsInScope(
        dto.professionalIds,
        scope.clinicId,
      );
    }

    return this.prisma.service.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.durationMin !== undefined
          ? { durationMin: dto.durationMin }
          : {}),
        ...(dto.bufferMin !== undefined ? { bufferMin: dto.bufferMin } : {}),
        ...(dto.priceCents !== undefined
          ? { priceCents: dto.priceCents }
          : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.professionalIds
          ? {
              professionals: {
                // Pre-validado arriba: `set` sólo con IDs del mismo tenant.
                set: dto.professionalIds.map((pid) => ({ id: pid })),
              },
            }
          : {}),
      },
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('clinicId') clinicIdOverride?: string,
  ): Promise<void> {
    // Soft-delete: marca `active = false`. NO hard delete para no romper
    // Appointment.serviceId (FK). El listado default filtra `active: true`.
    const scope = tenantWhere(user, clinicIdOverride);
    const existing = await this.prisma.service.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('servicio no encontrado');
    await this.prisma.service.update({
      where: { id },
      data: { active: false },
    });
  }
}
