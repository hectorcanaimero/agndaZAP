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
import { CreateBusinessHourDto } from './dto/create-business-hour.dto';
import { UpdateBusinessHourDto } from './dto/update-business-hour.dto';

/**
 * CRUD de `BusinessHour`. Hard delete OK — no rompe historial de citas.
 *
 * Validaciones semánticas:
 * - `endMinutes > startMinutes`.
 * - Si `professionalId` viene, debe pertenecer a la misma clínica.
 */
@Controller('business-hours')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class BusinessHoursController {
  constructor(private readonly prisma: PrismaService) {}

  private assertRange(startMinutes: number, endMinutes: number) {
    if (endMinutes <= startMinutes) {
      throw new BadRequestException('endMinutes debe ser mayor a startMinutes');
    }
  }

  private async assertProfessionalInClinic(
    clinicId: string,
    professionalId: string | undefined,
  ) {
    if (!professionalId) return;
    const prof = await this.prisma.professional.findFirst({
      where: { id: professionalId, clinicId },
      select: { id: true },
    });
    if (!prof) {
      throw new NotFoundException('profesional no encontrado en esta clínica');
    }
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateBusinessHourDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    this.assertRange(dto.startMinutes, dto.endMinutes);
    await this.assertProfessionalInClinic(scope.clinicId, dto.professionalId);
    return this.prisma.businessHour.create({
      data: {
        clinicId: scope.clinicId,
        weekday: dto.weekday,
        startMinutes: dto.startMinutes,
        endMinutes: dto.endMinutes,
        professionalId: dto.professionalId ?? null,
      },
    });
  }

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('clinicId') clinicIdOverride?: string,
    @Query('professionalId') professionalId?: string,
  ) {
    return this.prisma.businessHour.findMany({
      where: {
        ...tenantWhere(user, clinicIdOverride),
        ...(professionalId ? { professionalId } : {}),
      },
      orderBy: [{ weekday: 'asc' }, { startMinutes: 'asc' }],
    });
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateBusinessHourDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    const existing = await this.prisma.businessHour.findFirst({
      where: { id, clinicId: scope.clinicId },
    });
    if (!existing) throw new NotFoundException('business-hour no encontrado');

    const nextStart = dto.startMinutes ?? existing.startMinutes;
    const nextEnd = dto.endMinutes ?? existing.endMinutes;
    this.assertRange(nextStart, nextEnd);
    if (dto.professionalId !== undefined) {
      await this.assertProfessionalInClinic(
        scope.clinicId,
        dto.professionalId,
      );
    }

    return this.prisma.businessHour.update({
      where: { id },
      data: {
        ...(dto.weekday !== undefined ? { weekday: dto.weekday } : {}),
        ...(dto.startMinutes !== undefined
          ? { startMinutes: dto.startMinutes }
          : {}),
        ...(dto.endMinutes !== undefined ? { endMinutes: dto.endMinutes } : {}),
        ...(dto.professionalId !== undefined
          ? { professionalId: dto.professionalId }
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
    const existing = await this.prisma.businessHour.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('business-hour no encontrado');
    await this.prisma.businessHour.delete({ where: { id } });
  }
}
