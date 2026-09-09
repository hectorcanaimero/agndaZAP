import {
  BadRequestException,
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
import { normalizeE164 } from '../common/phone.util';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateClinicDto } from './dto/update-clinic.dto';

/** `+5804121234567` → `...4567`; null → `none`. Para logs sin PII completa. */
function maskPhone(phone: string | null): string {
  return phone ? `...${phone.slice(-4)}` : 'none';
}

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
  ) {
    const scope = tenantWhere(user);
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: scope.clinicId },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        locale: true,
        currency: true,
        address: true,
        publicWhatsappPhone: true,
        autoConfirm: true,
        reminderOffsetsH: true,
        confirmThresholdH: true,
        botGreeting: true,
        botFallback: true,
        botHandoffMsg: true,
        botTone: true,
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
  ) {
    const scope = tenantWhere(user);
    const before = await this.prisma.clinic.findUnique({
      where: { id: scope.clinicId },
      select: { timezone: true, publicWhatsappPhone: true },
    });
    if (!before) throw new NotFoundException('clínica no encontrada');

    // Opt-in del WhatsApp público: '' → NULL (dejar de exponer); si viene
    // valor lo canonizamos a E.164 con `+`. Un null tras pasar el DTO es un
    // bug, no un caso de usuario → 400 defensivo (mismo criterio que Patient).
    let publicWhatsappPhone: string | null | undefined;
    if (dto.publicWhatsappPhone !== undefined) {
      // `null` en JSON pasa @IsOptional; lo tratamos igual que '' (borrar).
      if (dto.publicWhatsappPhone === '' || dto.publicWhatsappPhone === null) {
        publicWhatsappPhone = null;
      } else {
        publicWhatsappPhone = normalizeE164(dto.publicWhatsappPhone);
        if (!publicWhatsappPhone) {
          throw new BadRequestException('publicWhatsappPhone inválido');
        }
      }
    }

    const updated = await this.prisma.clinic.update({
      where: { id: scope.clinicId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(publicWhatsappPhone !== undefined ? { publicWhatsappPhone } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
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
        currency: true,
        address: true,
        publicWhatsappPhone: true,
        autoConfirm: true,
        reminderOffsetsH: true,
        confirmThresholdH: true,
        botGreeting: true,
        botFallback: true,
        botHandoffMsg: true,
        botTone: true,
      },
    });

    if (
      publicWhatsappPhone !== undefined &&
      publicWhatsappPhone !== before.publicWhatsappPhone
    ) {
      // Trail "de qué a qué" sin loguear el número completo: sólo últimos 4.
      this.logger.warn(
        `clinic public whatsapp change clinicId=${scope.clinicId} ${maskPhone(before.publicWhatsappPhone)}->${maskPhone(publicWhatsappPhone)} by=${user.userId}`,
      );
    }

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
}
