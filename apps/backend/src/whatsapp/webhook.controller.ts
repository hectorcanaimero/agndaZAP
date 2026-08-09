import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { BotService } from '../bot/bot.service';
import { PrismaService } from '../prisma/prisma.service';
import { WahaWebhookDto } from './dto/waha-webhook.dto';

/** Shape mínima esperada dentro de `payload` cuando `event === 'message'`. */
interface WahaMessagePayload {
  fromMe?: boolean;
  from?: string;
  body?: string;
}

/** Shape mínima esperada dentro de `payload` cuando `event === 'session.status'`. */
interface WahaSessionStatusPayload {
  status?: string;
}

/**
 * Recibe los eventos de WAHA. La URL se configura en WHATSAPP_HOOK_URL.
 * Resolvemos la clínica por el nombre de la sesión (una sesión WAHA por clínica).
 *
 * `@Public()` a nivel controller: opt-out del `JwtAuthGuard` global. Aunque la
 * ruta vive fuera del prefijo `/api` (excluida en main.ts), el guard global
 * corre igual y bloquearía sin este marcador. La autenticidad del webhook la
 * valida (opcionalmente) `WEBHOOK_TOKEN`.
 */
@Public()
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: BotService,
  ) {}

  // Convención de webhooks: 200 OK aunque el evento no aplique. Evita reintentos
  // agresivos del emisor por códigos "raros" (Nest devuelve 201 por default en @Post).
  @Post('waha')
  @HttpCode(200)
  async handleWaha(
    @Body() dto: WahaWebhookDto,
    @Headers('x-webhook-token') token?: string,
  ) {
    // Validación del webhook (evita inyección externa).
    // NOTA: WAHA no envía headers custom por defecto. Debe configurarse con
    // `WHATSAPP_HOOK_HEADERS='x-webhook-token: <token>'` para que este check
    // funcione contra la instancia WAHA real. Alternativa futura: usar el
    // `WEBHOOK_HMAC` de WAHA con verificación por firma en vez de token estático.
    const requiredToken = process.env.WEBHOOK_TOKEN;
    if (process.env.NODE_ENV === 'production' && !requiredToken) {
      // En prod, sin token configurado el webhook queda expuesto — fail-closed.
      throw new ForbiddenException('WEBHOOK_TOKEN no configurado en producción');
    }
    if (requiredToken && token !== requiredToken) {
      throw new ForbiddenException('token de webhook inválido');
    }

    const { event, session, payload } = dto;

    const clinic = await this.prisma.clinic.findUnique({
      where: { wahaSession: session },
    });
    if (!clinic) {
      // Session desconocida ≠ ataque necesariamente (puede ser una clínica
      // renombrada o una sesión residual de WAHA). Loguear con warn para
      // detectar patrones raros sin ensuciar el flujo con excepciones.
      this.logger.warn(`webhook con session desconocida: ${session}`);
      return { ok: true };
    }

    if (event === 'session.status') {
      const statusPayload = payload as WahaSessionStatusPayload | undefined;
      const connected = statusPayload?.status === 'WORKING';
      await this.prisma.clinic.update({
        where: { id: clinic.id },
        data: { wahaConnected: connected },
      });
      return { ok: true };
    }

    if (event === 'message') {
      const msg = payload as WahaMessagePayload | undefined;
      if (msg?.fromMe) return { ok: true }; // ignorar salientes
      const from = msg?.from ?? '';
      const body = msg?.body ?? '';
      if (!from) return { ok: true };

      await this.bot.handleIncoming({
        clinicId: clinic.id,
        chatId: from,
        phone: from.replace('@c.us', ''),
        text: body,
      });
    }

    return { ok: true };
  }
}
