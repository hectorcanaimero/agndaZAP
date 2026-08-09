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
import { CreateProfessionalDto } from './dto/create-professional.dto';
import { UpdateProfessionalDto } from './dto/update-professional.dto';

/**
 * CRUD de `Professional`. Soft-delete via `active = false`.
 * M-N con `Service` — `serviceIds` opcional en create/patch.
 */
@Controller('professionals')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class ProfessionalsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Valida que todos los `serviceIds` pertenecen a la misma clínica del scope.
   * Sin esto, `connect`/`set` linkearía servicios cross-tenant (audit B1).
   */
  private async assertServicesInScope(
    ids: string[],
    clinicId: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.prisma.service.findMany({
      where: { id: { in: ids }, clinicId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException(
        'algún serviceId no pertenece a esta clínica',
      );
    }
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProfessionalDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    if (dto.serviceIds && dto.serviceIds.length > 0) {
      await this.assertServicesInScope(dto.serviceIds, scope.clinicId);
    }
    return this.prisma.professional.create({
      data: {
        clinicId: scope.clinicId,
        name: dto.name,
        active: true,
        ...(dto.serviceIds && dto.serviceIds.length > 0
          ? {
              services: {
                // Pre-validado arriba: sólo IDs del mismo tenant.
                connect: dto.serviceIds.map((id) => ({ id })),
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
    return this.prisma.professional.findMany({
      where: { ...tenantWhere(user, clinicIdOverride), active: true },
      orderBy: { name: 'asc' },
      include: {
        services: { where: { active: true }, select: { id: true, name: true } },
      },
    });
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const prof = await this.prisma.professional.findFirst({
      where: { id, ...tenantWhere(user, clinicIdOverride) },
      include: {
        services: { select: { id: true, name: true } },
      },
    });
    if (!prof) throw new NotFoundException('profesional no encontrado');
    return prof;
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProfessionalDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    const existing = await this.prisma.professional.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('profesional no encontrado');

    if (dto.serviceIds && dto.serviceIds.length > 0) {
      await this.assertServicesInScope(dto.serviceIds, scope.clinicId);
    }

    return this.prisma.professional.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.serviceIds
          ? {
              services: {
                // Pre-validado arriba: `set` sólo con IDs del mismo tenant.
                set: dto.serviceIds.map((sid) => ({ id: sid })),
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
    const scope = tenantWhere(user, clinicIdOverride);
    const existing = await this.prisma.professional.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('profesional no encontrado');
    await this.prisma.professional.update({
      where: { id },
      data: { active: false },
    });
  }
}
