import {
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';

/**
 * `GET /api/clinics/me` — devuelve el meta-info de la clínica del usuario:
 *   { id, name, slug, timezone, locale }
 *
 * Sólo expone campos "públicos" (nada de secretos WAHA, config interna, etc).
 * Consumido por el frontend cuando necesita la TZ o el locale de la clínica
 * (agenda picker, formateo de fechas, etc.).
 */
@Controller('clinics')
@UseGuards(RolesGuard)
export class ClinicsController {
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
      },
    });
    if (!clinic) throw new NotFoundException('clínica no encontrada');
    return clinic;
  }
}
