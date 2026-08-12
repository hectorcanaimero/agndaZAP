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
import { CreateBusinessHoursBulkDto } from './dto/create-business-hours-bulk.dto';
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

  /**
   * Creación atómica de N BusinessHour dentro de una transacción Prisma.
   *
   * El caso de uso principal es el step 4 del wizard de onboarding: aplicar
   * un preset (L-V 9-18, o partido con dos turnos) que genera 5-14 rows a la
   * vez. Con N POST individuales, un fallo parcial deja horarios rotos que
   * requieren cleanup manual. Con la transacción, o entran todos o ninguno.
   *
   * Validamos rangos + tenant del profesional para CADA row antes de tocar
   * la DB — así fallamos rápido con un 400 claro en lugar de que la
   * transacción reviente a mitad de camino con un error genérico.
   */
  @Post('bulk')
  async createBulk(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateBusinessHoursBulkDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);

    for (const row of dto.hours) {
      this.assertRange(row.startMinutes, row.endMinutes);
    }
    const uniqueProfIds = Array.from(
      new Set(dto.hours.map((h) => h.professionalId).filter(Boolean)),
    ) as string[];
    for (const profId of uniqueProfIds) {
      await this.assertProfessionalInClinic(scope.clinicId, profId);
    }

    return this.prisma.$transaction(
      dto.hours.map((row) =>
        this.prisma.businessHour.create({
          data: {
            clinicId: scope.clinicId,
            weekday: row.weekday,
            startMinutes: row.startMinutes,
            endMinutes: row.endMinutes,
            professionalId: row.professionalId ?? null,
          },
        }),
      ),
    );
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
