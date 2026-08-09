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
import { DateTime } from 'luxon';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTimeOffDto } from './dto/create-time-off.dto';
import { UpdateTimeOffDto } from './dto/update-time-off.dto';

/**
 * CRUD de `TimeOff` (bloqueos / vacaciones). Hard delete OK.
 *
 * Regla dura: `endAt > startAt`. Parse via Luxon con la TZ de la clínica —
 * DB persiste UTC (JSDate). El frontend recibe strings ISO y renderiza en la
 * TZ que corresponda.
 */
@Controller('time-off')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class TimeOffController {
  constructor(private readonly prisma: PrismaService) {}

  private async getClinicTimezone(clinicId: string): Promise<string> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    if (!clinic) throw new NotFoundException('clínica no encontrada');
    return clinic.timezone;
  }

  private parseRange(
    tz: string,
    startAt: string,
    endAt: string,
  ): { start: Date; end: Date } {
    const startDT = DateTime.fromISO(startAt, { zone: tz });
    const endDT = DateTime.fromISO(endAt, { zone: tz });
    if (!startDT.isValid || !endDT.isValid) {
      throw new BadRequestException('startAt/endAt inválidos');
    }
    if (endDT <= startDT) {
      throw new BadRequestException('endAt debe ser mayor a startAt');
    }
    return { start: startDT.toJSDate(), end: endDT.toJSDate() };
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
    @Body() dto: CreateTimeOffDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    const tz = await this.getClinicTimezone(scope.clinicId);
    const { start, end } = this.parseRange(tz, dto.startAt, dto.endAt);
    await this.assertProfessionalInClinic(scope.clinicId, dto.professionalId);
    return this.prisma.timeOff.create({
      data: {
        clinicId: scope.clinicId,
        startAt: start,
        endAt: end,
        reason: dto.reason ?? null,
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
    return this.prisma.timeOff.findMany({
      where: {
        ...tenantWhere(user, clinicIdOverride),
        ...(professionalId ? { professionalId } : {}),
      },
      orderBy: { startAt: 'asc' },
    });
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTimeOffDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    const existing = await this.prisma.timeOff.findFirst({
      where: { id, clinicId: scope.clinicId },
    });
    if (!existing) throw new NotFoundException('time-off no encontrado');

    const tz = await this.getClinicTimezone(scope.clinicId);
    const nextStartISO =
      dto.startAt ?? DateTime.fromJSDate(existing.startAt).toISO()!;
    const nextEndISO =
      dto.endAt ?? DateTime.fromJSDate(existing.endAt).toISO()!;
    const { start, end } = this.parseRange(tz, nextStartISO, nextEndISO);

    if (dto.professionalId !== undefined) {
      await this.assertProfessionalInClinic(
        scope.clinicId,
        dto.professionalId,
      );
    }

    return this.prisma.timeOff.update({
      where: { id },
      data: {
        ...(dto.startAt !== undefined ? { startAt: start } : {}),
        ...(dto.endAt !== undefined ? { endAt: end } : {}),
        ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
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
    const existing = await this.prisma.timeOff.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('time-off no encontrado');
    await this.prisma.timeOff.delete({ where: { id } });
  }
}
