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
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { Public } from '../auth/decorators/public.decorator';
import { BotService } from '../bot/bot.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeE164 } from '../common/phone.util';
import { REDIS_CLIENT } from '../public/rate-limit.guard';
import { WahaService } from './waha.service';
import { verifyWebhookAuthFromEnv } from './webhook-auth.util';

/**
 * Shape del cuerpo del webhook. NO usamos DTO con class-validator porque el
 * ValidationPipe global tiene `forbidNonWhitelisted: true` y WAHA envía muchos
 * campos (id, timestamp, me, engine, environment…) que no controlamos. Un
 * @UsePipes local no puede suavizar al pipe global — por eso validamos manual.
 */
export interface WahaWebhookBody {
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
  /**
   * WAHA lo pone en `true` cuando el mensaje trae un adjunto (audio, imagen,
   * documento…). El adjunto en sí NO viaja en el webhook: hay que pedirlo
   * aparte a la API de WAHA, así que para el bot es texto que no existe.
   */
  hasMedia?: boolean;
  /**
   * Tipo del mensaje. El engine NOWEB manda `chat` para texto y `ptt`,
   * `audio`, `image`, `video`, `sticker`, `location`, `document`, `vcard`…
   * para el resto. Algunas versiones sólo lo traen dentro de `_data`.
   */
  type?: string;
  _data?: {
    notifyName?: string;
    pushName?: string;
    type?: string;
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

  /** Tipos de `payload.type` que sí traen el texto en `payload.body`. */
  private static readonly TEXT_TYPES = new Set(['chat', 'text']);

  /**
   * Eventos que llegan como `message` pero no son un mensaje del paciente:
   * reacciones, avisos de cifrado, mensajes de protocolo, mensajes borrados.
   * Se ignoran del todo — ni bandeja ni respuesta. Sin esto, reaccionar con 👍
   * a la confirmación de una cita contesta "solo puedo leer texto".
   */
  private static readonly IGNORED_TYPES = new Set([
    'reaction',
    'e2e_notification',
    'notification_template',
    'protocol',
    'gp2',
    'ciphertext',
    'revoked',
  ]);

  /** Tope del pie de foto que guardamos junto a la etiqueta. */
  private static readonly MAX_CAPTION_CHARS = 500;

  // Espejo de `BotService.PER_CHAT_LIMIT` / `PER_CLINIC_HOURLY_LIMIT`
  // (ADR 0007). Si cambian allí, cambian aquí — comparten las claves de Redis.
  private static readonly PER_CHAT_LIMIT = 15;
  private static readonly PER_CLINIC_HOURLY_LIMIT = 500;

  /**
   * Una sola respuesta "solo leo texto" por conversación cada 6 h. Sin esto,
   * alguien que manda cinco notas de voz seguidas recibe cinco veces el mismo
   * mensaje y el bot parece roto.
   */
  private static readonly MEDIA_NOTICE_TTL_SEC = 21_600;

  /** Tuteo LATAM neutro, como el resto del copy del bot. */
  private static readonly MEDIA_NOTICE_TEXT =
    'Por ahora solo puedo leer mensajes de texto. ¿Me escribes lo que necesitas?';

  /**
   * Variante para adjuntos que vienen con pie de foto. El paciente SÍ escribió
   * algo, así que decirle "solo leo texto" a secas es falso desde su lado.
   */
  private static readonly MEDIA_NOTICE_TEXT_WITH_CAPTION =
    'No puedo abrir lo que me mandaste, pero sí leo tus mensajes. ¿Me cuentas por aquí qué necesitas?';

  /**
   * Etiqueta con la que queda el mensaje en la bandeja. No guardamos el
   * adjunto (no viene en el webhook), pero sí dejamos rastro de que llegó algo
   * para que quien atienda entienda el hueco en la conversación.
   */
  private static readonly MEDIA_LABELS: Readonly<Record<string, string>> = {
    audio: '[audio]',
    ptt: '[audio]',
    voice: '[audio]',
    image: '[imagen]',
    video: '[video]',
    sticker: '[sticker]',
    location: '[ubicación]',
    document: '[archivo]',
    vcard: '[contacto]',
    contact_card: '[contacto]',
    multi_vcard: '[contacto]',
    poll_creation: '[encuesta]',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: BotService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly waha: WahaService,
  ) {}

  /**
   * Clave de dedup. Los ids de WAHA tienen forma `false_<phone>@c.us_<hex>`
   * (contienen el teléfono), los genera el cliente y no tienen longitud
   * acotada: hasheamos `from|id` → tamaño fijo, sin PHI y sin input hostil.
   *
   * Ojo: esto NO es una política de "nada de teléfonos en Redis" — la clave
   * del aviso de media lleva el `chatId` en claro, igual que
   * `bot:msg:{clinicId}:{chatId}:{minuto}` en `bot.service.ts`. Hashear ambas
   * a la vez es deuda anotada en la nota de esta feature.
   */
  private dedupKey(session: string, from: string, messageId: string): string {
    const digest = createHash('sha256')
      .update(`${from}|${messageId}`)
      .digest('hex');
    return `waha:evt:${session}:${digest}`;
  }

  /**
   * Dedup de eventos `message`: WAHA reintenta el webhook si no recibe 200 a
   * tiempo y puede entregar el mismo mensaje dos veces (→ doble respuesta del
   * bot / doble cita). `SET NX` atómico por clave hasheada.
   *
   * - Devuelve `true` si es la PRIMERA vez que vemos el id (procesar).
   * - Fail-open: si Redis falla, procesar (mejor un duplicado que perder
   *   mensajes). Log `warn` sin PII.
   */
  private async claimMessage(key: string): Promise<boolean> {
    try {
      const result = await this.redis.set(
        key,
        '1',
        'EX',
        WebhookController.DEDUP_TTL_SEC,
        'NX',
      );
      return result !== null;
    } catch (e) {
      this.logger.warn(
        `dedup webhook falló (redis): ${(e as Error).message}`,
      );
      return true;
    }
  }

  /**
   * Si el bot falló, liberamos la marca para que el reintento de WAHA sí se
   * procese. Best-effort: si Redis también falla, el TTL la limpia en 24h.
   */
  private async releaseMessage(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (e) {
      this.logger.warn(
        `dedup webhook: no se pudo liberar la clave (redis): ${(e as Error).message}`,
      );
    }
  }

  /**
   * ¿Este mensaje trae texto que el bot pueda leer? Devuelve `null` si sí
   * (camino normal) y la etiqueta para la bandeja si no.
   *
   * Tres señales, cualquiera basta para descartarlo:
   * 1. `type` (o `_data.type`) fuera de {chat, text} — un `ptt`, una `image`…
   * 2. `hasMedia === true` — adjunto; el binario no viaja en el webhook.
   * 3. `body` vacío — no hay nada que clasificar ni que pasarle al LLM.
   *
   * Una imagen con pie de foto entra por (2) aunque `body` traiga texto: el
   * pie casi nunca se entiende sin la imagen, así que va a la bandeja con el
   * texto conservado detrás de la etiqueta en vez de al bot.
   */
  private mediaLabel(
    msg: WahaMessagePayload | undefined,
    body: string,
  ): string | null {
    const type = (msg?.type ?? msg?._data?.type ?? '').toLowerCase();
    const isTextType = type === '' || WebhookController.TEXT_TYPES.has(type);
    const hasMedia = msg?.hasMedia === true;

    // Si WAHA dice que es un chat Y hay texto, va al bot aunque marque
    // `hasMedia` (p. ej. un texto con preview de link). El falso positivo al
    // revés es peor: el paciente escribe "quiero cita el martes", le
    // contestamos "solo leo texto" y la FSM nunca arranca, en silencio.
    if (isTextType && body.trim() !== '') return null;
    if (isTextType && !hasMedia) return '[mensaje sin texto]';

    // `MEDIA_LABELS` es un object literal: sin `hasOwn`, un `type` de
    // `constructor` o `__proto__` (que vienen del payload, atacante-controlado)
    // devuelve algo de `Object.prototype` en vez de undefined, y esa función
    // terminaba en el `body: String` de Prisma → error de validación → 500 →
    // reintento infinito de WAHA.
    if (Object.hasOwn(WebhookController.MEDIA_LABELS, type)) {
      return WebhookController.MEDIA_LABELS[type];
    }
    return hasMedia ? '[archivo]' : '[mensaje sin texto]';
  }

  /**
   * Rate-limit del ADR 0007 aplicado al camino de los adjuntos.
   *
   * `BotService.handleIncoming` trae las dos capas dentro, pero este camino no
   * pasa por ahí: sin esto, un flood de stickers escribe en `Conversation` y
   * `Message` sin cota (justo el ataque que motivó el ADR) y, con el token del
   * webhook comprometido, saca un `sendText` por request variando `from`,
   * saltándose el cap horario que protege el número de la clínica.
   *
   * Usa LAS MISMAS claves que `bot.service.ts:354` y `:365`, así que el
   * presupuesto es compartido y un mensaje se cuenta una sola vez (los de
   * texto los cuenta el bot, los adjuntos los contamos aquí).
   *
   * Fail-open ante Redis caído, igual que el bot: la cota real la ponen los
   * constraints de la DB y el resto de rate-limits.
   *
   * TODO: cuando el PR A1 (que es dueño de `bot.service.ts` durante el P0)
   * esté en `main`, extraer este bloque y el de `handleIncoming` a un helper
   * compartido en vez de tener la lógica en dos sitios.
   */
  private async withinRateLimit(
    clinicId: string,
    chatId: string,
  ): Promise<boolean> {
    try {
      const now = Date.now();
      const rlKey = `bot:msg:${clinicId}:${chatId}:${Math.floor(now / 60000)}`;
      const count = await this.redis.incr(rlKey);
      if (count === 1) await this.redis.expire(rlKey, 90);
      if (count > WebhookController.PER_CHAT_LIMIT) {
        this.logger.warn(
          `media rate-limit clinic=${clinicId} chat=${this.hashChatId(chatId)} count=${count}`,
        );
        return false;
      }

      const chKey = `bot:msg:${clinicId}:hour:${Math.floor(now / 3600000)}`;
      const hourCount = await this.redis.incr(chKey);
      if (hourCount === 1) await this.redis.expire(chKey, 3900);
      if (hourCount > WebhookController.PER_CLINIC_HOURLY_LIMIT) {
        this.logger.error(
          `bot hourly cap clinic=${clinicId} count=${hourCount} — circuit OPEN`,
        );
        return false;
      }
      return true;
    } catch (e) {
      this.logger.error(
        `media rate-limit falló (redis) clinic=${clinicId}: ${(e as Error).message}`,
      );
      return true; // fail-open, igual que el bot
    }
  }

  /** Hash corto del chatId para logs: correlacionable, sin teléfono. */
  private hashChatId(chatId: string): string {
    return createHash('sha256').update(chatId).digest('hex').slice(0, 12);
  }

  /**
   * Throttle de la respuesta automática: `SET NX` por conversación con TTL de
   * 6 h. `true` = te toca responder.
   *
   * Fail-CLOSED a propósito, al revés que el dedup: si Redis no está, el coste
   * de no responder es un mensaje menos, y el de responder es repetirle lo
   * mismo al paciente en cada nota de voz. El mensaje entrante ya quedó
   * registrado en la bandeja de cualquier forma.
   */
  private async claimMediaNotice(
    clinicId: string,
    chatId: string,
  ): Promise<boolean> {
    try {
      const result = await this.redis.set(
        `bot:media-notice:${clinicId}:${chatId}`,
        '1',
        'EX',
        WebhookController.MEDIA_NOTICE_TTL_SEC,
        'NX',
      );
      return result !== null;
    } catch (e) {
      this.logger.warn(
        `throttle de aviso de media falló (redis) clinic=${clinicId}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Mensaje sin texto: registrar y avisar, sin pasar por el bot (nada de LLM,
   * de FSM ni de RAG — no hay texto que interpretar).
   *
   * El registro (`Conversation` + `Message IN`) se hace SIEMPRE, también con
   * `state = HUMAN`: quien atiende necesita ver que entró un audio. Lo que el
   * `HUMAN` silencia es sólo la respuesta automática, igual que en el bot.
   */
  private async handleUnsupportedMessage(params: {
    clinic: { id: string; wahaSession: string };
    chatId: string;
    phone: string | null;
    lid: string | null;
    contactName: string | null;
    label: string;
    caption: string;
  }): Promise<void> {
    const { clinic, chatId, phone, lid, contactName, label, caption } = params;

    // Mismo upsert que `BotService.handleIncoming`: en update sólo tocamos
    // contactName/phone cuando vienen, para no pisarlos con null.
    const convo = await this.prisma.conversation.upsert({
      where: { clinicId_chatId: { clinicId: clinic.id, chatId } },
      create: {
        clinicId: clinic.id,
        chatId,
        phone,
        lid,
        contactName,
        state: 'BOT',
      },
      update: {
        ...(contactName ? { contactName } : {}),
        ...(phone ? { phone } : {}),
      },
    });

    await this.prisma.message.create({
      data: {
        conversationId: convo.id,
        direction: 'IN',
        body: caption ? `${label} ${caption}` : label,
      },
    });

    if (convo.state === 'HUMAN') return;
    if (!(await this.claimMediaNotice(clinic.id, chatId))) return;

    const text = caption
      ? WebhookController.MEDIA_NOTICE_TEXT_WITH_CAPTION
      : WebhookController.MEDIA_NOTICE_TEXT;

    // El aviso es best-effort y NO relanza: lo durable (Conversation + Message
    // IN) ya está escrito. Si relanzáramos, WAHA reintentaría, el
    // `message.create` del IN duplicaría la fila en la bandeja y el throttle ya
    // consumido dejaría al paciente sin aviso durante 6 h. Liberamos la clave
    // para poder avisar en el próximo adjunto.
    try {
      await this.waha.sendText(clinic.wahaSession, chatId, text);
      await this.prisma.message.create({
        data: { conversationId: convo.id, direction: 'OUT', body: text },
      });
    } catch (e) {
      await this.releaseMediaNotice(clinic.id, chatId);
      this.logger.warn(
        `aviso de media no enviado clinic=${clinic.id}: ${(e as Error).message}`,
      );
    }
  }

  /** Libera el throttle para poder reintentar el aviso en el próximo adjunto. */
  private async releaseMediaNotice(
    clinicId: string,
    chatId: string,
  ): Promise<void> {
    try {
      await this.redis.del(`bot:media-notice:${clinicId}:${chatId}`);
    } catch (e) {
      this.logger.warn(
        `no se pudo liberar el throttle de media clinic=${clinicId}: ${(e as Error).message}`,
      );
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
      // Clínica SUSPENDED/ARCHIVED: el bot no responde (misma regla que los
      // endpoints públicos). `session.status` se sigue procesando arriba para
      // no perder el estado de la sesión WAHA. Log sin PII: sólo clinicId.
      if (clinic.status !== 'ACTIVE') {
        this.logger.debug(
          `webhook message ignorado: clínica no activa clinicId=${clinic.id} status=${clinic.status}`,
        );
        return { ok: true };
      }

      const msg = payload as WahaMessagePayload | undefined;
      if (msg?.fromMe) return { ok: true }; // ignorar salientes
      const from = msg?.from ?? '';
      const body = msg?.body ?? '';
      if (!from) return { ok: true };

      // Grupos y estados: el bot no participa. Antes casi no importaba (rara
      // vez traen texto que dispare algo); ahora sí, porque los adjuntos
      // reciben respuesta — y un sticker en un grupo donde está el número de
      // la clínica haría que contestemos "solo puedo leer texto" ahí dentro.
      if (
        from.endsWith('@g.us') ||
        from.endsWith('@broadcast') ||
        from === 'status@broadcast'
      ) {
        return { ok: true };
      }

      // Sin `payload.id` no podemos deduplicar → procesar normal.
      const messageId = typeof msg?.id === 'string' ? msg.id : undefined;
      const dedupKey = messageId
        ? this.dedupKey(session, from, messageId)
        : null;
      if (dedupKey && !(await this.claimMessage(dedupKey))) {
        // Reintento de WAHA: ya lo procesamos. Sólo un prefijo del hash en el
        // log — nunca el id crudo (contiene el phone).
        const hashPrefix = dedupKey.slice(dedupKey.lastIndexOf(':') + 1, -52);
        this.logger.debug(
          `webhook duplicado ignorado session=${session} hash=${hashPrefix}…`,
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

      // Reacciones y eventos de sistema: ni bandeja ni respuesta.
      const rawType = (msg?.type ?? msg?._data?.type ?? '').toLowerCase();
      if (WebhookController.IGNORED_TYPES.has(rawType)) return { ok: true };

      // Audio, imagen, sticker, ubicación, documento…: no llegan al bot.
      // Antes caían en `handleIncoming` con `text: ''`, que no matchea nada y
      // terminaba en el fallback genérico (o gastando LLM) sin decirle al
      // paciente por qué no lo entendimos. Ver B4 del análisis del bot.
      const label = this.mediaLabel(msg, body);
      if (label) {
        // ADR 0007 antes de escribir nada: este camino no pasa por
        // `BotService.handleIncoming`, que es donde viven las dos capas.
        if (!(await this.withinRateLimit(clinic.id, from))) {
          return { ok: true };
        }
        try {
          await this.handleUnsupportedMessage({
            clinic,
            chatId: from,
            phone,
            lid,
            contactName,
            label,
            // Truncado: el pie va pegado a la etiqueta en un campo sin
            // discriminador de tipo, así que acotamos lo que un tercero puede
            // escribir en la bandeja.
            caption: body.trim().slice(0, WebhookController.MAX_CAPTION_CHARS),
          });
        } catch (e) {
          if (dedupKey) await this.releaseMessage(dedupKey);
          throw e;
        }
        return { ok: true };
      }

      try {
        await this.bot.handleIncoming({
          clinicId: clinic.id,
          chatId: from,
          phone,
          lid,
          contactName,
          text: body,
        });
      } catch (e) {
        // Liberamos la marca de dedup y relanzamos: WAHA reintenta y el
        // segundo intento sí se procesa. Sin esto el mensaje se perdía.
        if (dedupKey) await this.releaseMessage(dedupKey);
        throw e;
      }
    }

    return { ok: true };
  }
}
