import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { assertClinicScope, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimit } from '../public/rate-limit.guard';
import { WahaService } from './waha.service';

/**
 * WhatsappPanelController — superficie HTTP scopeada por JWT para conectar y
 * observar la sesión WAHA de la clínica del usuario autenticado.
 *
 * Contrato (ver docs/notas/2026-08-09-bloque-waha-panel-conexion.md §Contratos):
 *  - `GET /api/clinics/me/waha/status`
 *
 * Guards:
 *  - `JwtAuthGuard` es GLOBAL (APP_GUARD en AuthModule) → no hace falta declararlo.
 *  - `RolesGuard` + `@Roles('CLINIC_ADMIN', 'SUPERADMIN')` a nivel controller.
 *  - `RateLimit(20, 'waha-status')` a nivel handler (scope explícito para no
 *    colisionar con el rate-limit por `:slug` de rutas públicas).
 *
 * Reglas duras:
 *  - El `session` **nunca** se acepta del cliente: se deriva vía
 *    `assertClinicScope(user)` + `clinic.wahaSession`. Precedente idéntico al
 *    `tenantWhere` del resto del panel (ADR 0006 §1).
 *  - `assertClinicScope(user)` sin override → SUPERADMIN devuelve 400. Es la
 *    decisión intencional del ADR: un SUPERADMIN que necesita operar sobre WAHA
 *    de una clínica usa las credenciales técnicas directas (Q3 + §8 del plan).
 *  - Cero PII en logs: nunca se loguea el string del QR — sólo su presencia.
 */
@Controller('clinics/me/waha')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class WhatsappPanelController {
  private readonly logger = new Logger(WhatsappPanelController.name);

  constructor(
    private readonly waha: WahaService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Devuelve el estado actual de la sesión WAHA de la clínica del user.
   *
   * Response shape:
   *   `{ status: 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED' | 'STOPPED' | 'UNKNOWN', session: string, qr?: string }`
   *
   * Notas de diseño:
   *  - Cuando `getSessionStatus` no reconoce el status (WAHA down o 5xx),
   *    devuelve `'UNKNOWN'` sin tirar. Preferimos degradación visible
   *    sobre falso `WORKING`. El próximo poll re-intenta (no cacheamos).
   *  - Sólo pedimos el QR cuando el status es `SCAN_QR_CODE` — cualquier otro
   *    estado que consulte QR amplificaría fallos de WAHA.
   *  - Si el QR viene `null` (WAHA no lo tiene todavía, 404, etc.), NO
   *    incluimos la clave `qr` en la response — el frontend la trata como
   *    ausencia y muestra spinner hasta el próximo poll.
   */
  @Get('status')
  @UseGuards(RateLimit(20, 'waha-status'))
  async status(@CurrentUser() user: AuthUser): Promise<{
    status: string;
    session: string;
    qr?: string;
  }> {
    const clinicId = assertClinicScope(user);
    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { wahaSession: true },
    });

    const status = await this.waha.getSessionStatus(clinic.wahaSession);

    let qr: string | null = null;
    if (status === 'SCAN_QR_CODE') {
      qr = await this.waha.getQrCode(clinic.wahaSession);
    }

    // Cero PII en logs: sólo booleanizamos la presencia del QR. El string base64
    // permite secuestrar la sesión de WhatsApp mientras el QR está vigente.
    this.logger.debug({
      clinicId,
      status,
      qr: qr ? 'present' : 'absent',
    });

    return {
      status,
      session: clinic.wahaSession,
      ...(qr ? { qr } : {}),
    };
  }
}
