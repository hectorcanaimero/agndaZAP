import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { Public } from '../auth/decorators/public.decorator';
import { BotService } from '../bot/bot.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeE164 } from '../common/phone.util';
import { REDIS_CLIENT } from '../public/rate-limit.guard';
import { verifyWebhookAuthFromEnv } from './webhook-auth.util';

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

/**
 * Shape mínima esperada dentro de `payload` cuando `event === 'message'`.
 * `notifyName` es el pushName que el contacto tiene configurado en su perfil de
 * WhatsApp — nos lo manda WAHA en cada mensaje (puede venir en `_data.pushName`
 * en algunas versiones, se cubren ambos abajo).
 */
interface WahaMessagePayload {
  /** Id del mensaje en WAHA. Lo usamos para deduplicar reintentos. */
  id?: string;
  fromMe?: boolean;
  from?: string;
  body?: string;
  notifyName?: string;
  _data?: {
    notifyName?: string;
    pushName?: string;
  };
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

  /** TTL del marcador de dedup: WAHA reintenta en minutos, 24h es de sobra. */
  private static readonly DEDUP_TTL_SEC = 86_400;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: BotService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Dedup de eventos `message`: WAHA reintenta el webhook si no recibe 200 a
   * tiempo y puede entregar el mismo mensaje dos veces (→ doble respuesta del
   * bot / doble cita). `SET NX` atómico por (session, payload.id).
   *
   * - Devuelve `true` si es la PRIMERA vez que vemos el id (procesar).
   * - Sin `payload.id` no podemos deduplicar → procesar.
   * - Fail-open: si Redis falla, procesar (mejor un duplicado que perder
   *   mensajes). Log `warn` sin PII.
   */
  private async claimMessage(
    session: string,
    messageId: string | undefined,
  ): Promise<boolean> {
    if (!messageId) return true;
    try {
      const result = await this.redis.set(
        `waha:evt:${session}:${messageId}`,
        '1',
        'EX',
        WebhookController.DEDUP_TTL_SEC,
        'NX',
      );
      return result !== null;
    } catch (e) {
      this.logger.warn(
        `dedup webhook falló (redis) session=${session}: ${(e as Error).message}`,
      );
      return true;
    }
  }

  // Convención de webhooks: 200 OK aunque el evento no aplique. Evita reintentos
  // agresivos del emisor por códigos "raros" (Nest devuelve 201 por default en @Post).
  @Post('waha')
  @HttpCode(200)
  async handleWaha(
    @Body() body: WahaWebhookBody,
    @Req() req: { rawBody?: Buffer },
    @Headers('x-webhook-token') token?: string,
    @Headers('x-webhook-hmac') hmac?: string,
  ) {
    // Auth del webhook. Preferencia: HMAC > shared token > skip (opt-in explícito).
    // Ver `verifyWebhookAuth` en `webhook-auth.util.ts` para el detalle.
    const authResult = verifyWebhookAuthFromEnv(req.rawBody, token, hmac);
    if (authResult === 'skip-explicit') {
      this.logger.warn(
        'webhook sin auth — ALLOW_WEBHOOK_WITHOUT_TOKEN=true activo (dev only)',
      );
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

      const messageId = typeof msg?.id === 'string' ? msg.id : undefined;
      if (!(await this.claimMessage(session, messageId))) {
        // Reintento de WAHA: ya lo procesamos. Sin chatId ni body en el log.
        this.logger.debug(
          `webhook duplicado ignorado session=${session} msgId=${messageId}`,
        );
        return { ok: true };
      }

      // WhatsApp está migrando de <phone>@c.us a <lid>@lid (Linked ID) para
      // privacidad. Cuando llega un LID no tenemos forma pública de resolverlo
      // al phone real (WAHA no expone endpoint). Loggeamos payload en dev para
      // capturar qué campos alternativos manda Baileys (senderPn, remoteJidAlt)
      // y refinar la resolución. Sin body para evitar PII.
      if (
        process.env.NODE_ENV !== 'production' &&
        from.endsWith('@lid')
      ) {
        const { body: _b, ...msgSansBody } = (msg ?? {}) as Record<string, unknown>;
        this.logger.log(
          `[LID] chatId=${from} payload=${JSON.stringify(msgSansBody)}`,
        );
      }

      // Separar identidad del contacto. El `chatId` de WAHA viene con sufijo
      // `@c.us` (phone-based) o `@lid` (LID de privacidad). Guardamos ambos por
      // separado para poder mostrar el número real cuando lo conocemos y no
      // ensuciar la columna `phone` con LIDs.
      // `phone` pasa por `normalizeE164` (con `+`) para que coincida con el
      // formato con el que la página pública y el panel guardan `Patient.phone`.
      // Si WAHA manda algo que no es un número válido, tratamos el contacto
      // como sin phone (misma rama que `@lid`).
      const bareId = from.replace(/@(c\.us|lid|s\.whatsapp\.net)$/, '');
      const isLid = from.endsWith('@lid');
      const phone = isLid ? null : normalizeE164(bareId);
      const lid = isLid ? bareId : null;
      // pushName: WAHA lo expone como `notifyName` top-level o dentro de `_data`.
      const contactName =
        msg?.notifyName ?? msg?._data?.notifyName ?? msg?._data?.pushName ?? null;

      await this.bot.handleIncoming({
        clinicId: clinic.id,
        chatId: from,
        phone,
        lid,
        contactName,
        text: body,
      });
    }

    return { ok: true };
  }
}
