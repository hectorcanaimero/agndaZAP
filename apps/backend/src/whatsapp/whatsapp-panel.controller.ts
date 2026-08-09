import {
  BadGatewayException,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
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
 *  - `GET  /api/clinics/me/waha/status`
 *  - `POST /api/clinics/me/waha/start`   (202 Accepted, inicia sesión async)
 *  - `POST /api/clinics/me/waha/logout`  (200 OK, borra credenciales y fuerza re-QR)
 *
 * Guards:
 *  - `JwtAuthGuard` es GLOBAL (APP_GUARD en AuthModule) → no hace falta declararlo.
 *  - `RolesGuard` + `@Roles('CLINIC_ADMIN', 'SUPERADMIN')` a nivel controller.
 *  - `RateLimit(20, 'waha-status')` sólo en GET /status (los POSTs son acciones
 *    de admin: RolesGuard + assertClinicScope ya alcanzan como defensa; no
 *    justifican una capa extra de rate-limit).
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

  /**
   * Inicia (o reinicia) la sesión WAHA de la clínica del user.
   *
   * Response shape: `{ status: 'STARTING' }`. Es un ACK optimista: WAHA acepta
   * el pedido y arranca el ciclo `STARTING → SCAN_QR_CODE → WORKING` de forma
   * asíncrona. El frontend debe empezar a poll'ear `GET /status` para observar
   * la transición y renderizar el QR cuando aparezca.
   *
   * Errores:
   *  - WAHA responde 5xx → `WahaService.startSession` tira → aquí lo envolvemos
   *    como `BadGatewayException` (502). Nunca filtramos el mensaje interno de
   *    WAHA al cliente (podría contener detalles de infra).
   */
  @Post('start')
  @HttpCode(202)
  async start(@CurrentUser() user: AuthUser): Promise<{ status: 'STARTING' }> {
    const clinicId = assertClinicScope(user);
    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { wahaSession: true },
    });

    try {
      await this.waha.startSession(clinic.wahaSession);
    } catch (err) {
      this.logger.error({
        event: 'waha.start.failed',
        clinicId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new BadGatewayException('WAHA start failed');
    }

    this.logger.log({ event: 'waha.start', clinicId });
    return { status: 'STARTING' };
  }

  /**
   * Termina la sesión WAHA de la clínica del user y borra credenciales en WAHA.
   * El próximo `start` volverá a exigir escaneo de QR (comportamiento buscado).
   *
   * Response shape: `{ status: 'STOPPED' }`.
   *
   * Errores: mismo pattern que `start` — WAHA 5xx → `BadGatewayException` (502).
   */
  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser() user: AuthUser): Promise<{ status: 'STOPPED' }> {
    const clinicId = assertClinicScope(user);
    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { wahaSession: true },
    });

    try {
      await this.waha.logoutSession(clinic.wahaSession);
    } catch (err) {
      this.logger.error({
        event: 'waha.logout.failed',
        clinicId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new BadGatewayException('WAHA logout failed');
    }

    this.logger.log({ event: 'waha.logout', clinicId });
    return { status: 'STOPPED' };
  }
}
