import {
  BadRequestException,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { extractIp, type MinimalRequest } from '../common/extract-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/tenant-context.util';
import {
  ImpersonationResult,
  ImpersonationService,
} from './impersonation.service';

/**
 * ImpersonationController — endpoint que emite el JWT de impersonation.
 *
 * Ruta: `POST /api/admin/clinics/:id/impersonate`. Sólo SUPERADMIN.
 *
 * WHY el path bajo `admin/clinics/:id` y no bajo `clinics/:id`: el CRUD
 * público de clínicas (para CLINIC_ADMIN) vive en `/clinics`. El namespace
 * `/admin/*` es exclusivo del Área SaaS Admin y todos sus handlers son
 * SUPERADMIN-only. Separar los prefixes evita colisiones de guard y hace
 * evidente el scope de cada endpoint en el router.
 *
 * Ver ADR 0014 §Impersonation.
 */
@Controller('admin/clinics')
@UseGuards(RolesGuard)
export class ImpersonationController {
  private readonly trustProxy = process.env.TRUST_PROXY === 'true';

  constructor(private readonly impersonation: ImpersonationService) {}

  /**
   * Emite un JWT temporal (30 min) con `clinicId` = clínica objetivo +
   * `impersonatedBy` = el SUPERADMIN actual.
   *
   * Anti-nested-impersonation: si el JWT actual YA es impersonado (i.e.
   * `user.impersonatedBy` está seteado), cortamos con 400. Motivos:
   *  - Evita cadenas de impersonation ("super → clínica A → clínica B")
   *    que hacen ilegible el trail de auditoría.
   *  - Fuerza al operador a hacer un "logout de impersonation" explícito
   *    antes de cambiar de tenant — no hay switching silencioso.
   */
  @Post(':id/impersonate')
  @Roles('SUPERADMIN')
  @HttpCode(200)
  async impersonate(
    @CurrentUser() user: AuthUser,
    @Param('id') targetClinicId: string,
    @Req() req: MinimalRequest,
  ): Promise<ImpersonationResult> {
    if (user.impersonatedBy) {
      throw new BadRequestException(
        'ya estás impersonando otra clínica — salí primero antes de cambiar',
      );
    }

    return this.impersonation.createImpersonationToken({
      actorUserId: user.userId,
      targetClinicId,
      ip: extractIp(req, this.trustProxy),
      userAgent: req.headers['user-agent'] as string | undefined,
    });
  }
}
