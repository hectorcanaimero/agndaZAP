import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { OnboardingProgressDto } from './dto/onboarding-progress.dto';
import { UpdateClinicDto } from './dto/update-clinic.dto';

/**
 * Meta-info de la clínica del usuario.
 *
 * `GET /me` es abierto para todos los roles del panel (necesario para armar
 * el picker con la TZ de la clínica en /agenda, y para el brand en el header).
 *
 * `PATCH /me` es solo CLINIC_ADMIN/SUPERADMIN — no queremos que un
 * PROFESSIONAL cambie la config global de la clínica.
 */
@Controller('clinics')
@UseGuards(RolesGuard)
export class ClinicsController {
  private readonly logger = new Logger('ClinicsController');

  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  @Roles('CLINIC_ADMIN', 'SUPERADMIN', 'PROFESSIONAL')
  async me(
    @CurrentUser() user: AuthUser,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: scope.clinicId },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        locale: true,
        address: true,
        autoConfirm: true,
        reminderOffsetsH: true,
        confirmThresholdH: true,
        botGreeting: true,
        botFallback: true,
        botHandoffMsg: true,
        botTone: true,
        onboardingCompletedAt: true,
        onboardingProgress: true,
      },
    });
    if (!clinic) throw new NotFoundException('clínica no encontrada');
    return clinic;
  }

  /**
   * Patch parcial. NO se aceptan slug/wahaSession/wahaConnected (ver DTO).
   * Cambios de `timezone` con citas futuras es delicado — el frontend muestra
   * un warning antes de mandar. Acá no bloqueamos: es responsabilidad del
   * operador. Log de auditoría (CERO PII del paciente).
   */
  @Patch('me')
  @Roles('CLINIC_ADMIN', 'SUPERADMIN')
  async update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateClinicDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    const before = await this.prisma.clinic.findUnique({
      where: { id: scope.clinicId },
      select: { timezone: true },
    });
    if (!before) throw new NotFoundException('clínica no encontrada');

    const updated = await this.prisma.clinic.update({
      where: { id: scope.clinicId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
        ...(dto.autoConfirm !== undefined
          ? { autoConfirm: dto.autoConfirm }
          : {}),
        ...(dto.reminderOffsetsH !== undefined
          ? { reminderOffsetsH: dto.reminderOffsetsH }
          : {}),
        ...(dto.confirmThresholdH !== undefined
          ? { confirmThresholdH: dto.confirmThresholdH }
          : {}),
        ...(dto.botGreeting !== undefined
          ? { botGreeting: dto.botGreeting || null }
          : {}),
        ...(dto.botFallback !== undefined
          ? { botFallback: dto.botFallback || null }
          : {}),
        ...(dto.botHandoffMsg !== undefined
          ? { botHandoffMsg: dto.botHandoffMsg || null }
          : {}),
        ...(dto.botTone !== undefined
          ? { botTone: dto.botTone || null }
          : {}),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        locale: true,
        address: true,
        autoConfirm: true,
        reminderOffsetsH: true,
        confirmThresholdH: true,
        botGreeting: true,
        botFallback: true,
        botHandoffMsg: true,
        botTone: true,
      },
    });

    if (dto.timezone && dto.timezone !== before.timezone) {
      // Log específico — cambios de TZ afectan cómo se ven citas futuras.
      this.logger.warn(
        `clinic tz change clinicId=${scope.clinicId} ${before.timezone}->${dto.timezone} by=${user.userId}`,
      );
    } else {
      this.logger.log(
        `clinic settings update clinicId=${scope.clinicId} by=${user.userId} keys=${Object.keys(dto).join(',')}`,
      );
    }

    return updated;
  }

  /**
   * Onboarding wizard progress. Endpoint separado de `PATCH /me` para no
   * pollute el DTO principal — son concerns distintos (config vs progreso).
   *
   * - `progress` hace merge shallow sobre el JSON existente (el cliente manda
   *   solo las keys que cambian, no reenvía todo el objeto).
   * - `completed=true` setea `onboardingCompletedAt = NOW()` de forma
   *   idempotente: llamados subsecuentes NO actualizan el timestamp.
   * - Log SIN PII: solo clinicId + userId + step + flag completed.
   *
   * Ver docs/notas/2026-08-11-onboarding-wizard.md §Backend.
   */
  @Patch('me/onboarding')
  @Roles('CLINIC_ADMIN', 'SUPERADMIN')
  async updateOnboarding(
    @CurrentUser() user: AuthUser,
    @Body() dto: OnboardingProgressDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);

    // Merge shallow del progress: leer el existente, mergear con lo nuevo,
    // guardar. Prisma no tiene un `jsonb ||` nativo cross-driver, y la
    // cardinalidad esperada es baja (~1 write cada pocos segundos por user).
    const before = await this.prisma.clinic.findUnique({
      where: { id: scope.clinicId },
      select: { onboardingProgress: true, onboardingCompletedAt: true },
    });
    if (!before) throw new NotFoundException('clínica no encontrada');

    const nextProgress =
      dto.progress !== undefined
        ? {
            ...((before.onboardingProgress as Record<string, unknown>) ?? {}),
            ...dto.progress,
          }
        : (before.onboardingProgress as Record<string, unknown> | null);

    // Idempotencia: si ya está completado, no re-escribimos el timestamp.
    const nextCompletedAt =
      dto.completed === true && before.onboardingCompletedAt === null
        ? new Date()
        : before.onboardingCompletedAt;

    const updated = await this.prisma.clinic.update({
      where: { id: scope.clinicId },
      data: {
        ...(dto.progress !== undefined
          ? { onboardingProgress: nextProgress ?? undefined }
          : {}),
        ...(dto.completed === true && before.onboardingCompletedAt === null
          ? { onboardingCompletedAt: nextCompletedAt }
          : {}),
      },
      select: {
        onboardingCompletedAt: true,
        onboardingProgress: true,
      },
    });

    this.logger.log(
      `onboarding.progress clinicId=${scope.clinicId} by=${user.userId} step=${dto.step ?? '-'} completed=${dto.completed === true}`,
    );

    return updated;
  }
}
