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

/**
 * Shape del cuerpo del webhook. NO usamos DTO con class-validator porque el
 * ValidationPipe global tiene `forbidNonWhitelisted: true` y WAHA envía muchos
 * campos (id, timestamp, me, engine, environment…) que no controlamos. Un
 * @UsePipes local no puede suavizar al pipe global — por eso validamos manual.
 */
interface WahaWebhookBody {
  event?: string;
  session?: string;
  payload?: Record<string, unknown>;
  // WAHA agrega: id, timestamp, me, engine, environment, etc. Los ignoramos.
  [key: string]: unknown;
}

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
    @Body() body: WahaWebhookBody,
    @Headers('x-webhook-token') token?: string,
  ) {
    // Validación del webhook (evita inyección externa).
    // WAHA (build noweb-arm/community) NO envía WHATSAPP_HOOK_HEADERS custom
    // — es feature de WAHA Plus. Para prod, usar WEBHOOK_HMAC de WAHA con
    // verificación por firma, o exponer el backend detrás de un reverse-proxy
    // que valide auth antes de llegar al endpoint.
    const requiredToken = process.env.WEBHOOK_TOKEN;
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd && !requiredToken) {
      // En prod, sin token configurado el webhook queda expuesto — fail-closed.
      throw new ForbiddenException('WEBHOOK_TOKEN no configurado en producción');
    }
    if (requiredToken && token !== requiredToken) {
      // En dev, si el header simplemente no llegó (WAHA community no lo manda),
      // permitir con warning. Si vino con valor incorrecto, sigue rechazando.
      if (!isProd && !token) {
        this.logger.warn(
          'webhook sin x-webhook-token en dev — permitiendo (fail-open dev only). Configurar WEBHOOK_HMAC en prod.',
        );
      } else {
        throw new ForbiddenException('token de webhook inválido');
      }
    }

    const { event, session, payload } = body;
    if (typeof event !== 'string' || typeof session !== 'string') {
      this.logger.warn('webhook con event/session inválido');
      return { ok: true };
    }

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
