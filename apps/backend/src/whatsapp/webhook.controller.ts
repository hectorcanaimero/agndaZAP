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
import { Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import { Public } from '../auth/decorators/public.decorator';
import { Queue } from 'bullmq';
import {
  BOT_INBOUND_JOB,
  BOT_INBOUND_QUEUE_TOKEN,
  MAX_INBOUND_TEXT_CHARS,
  type BotInboundJobData,
} from '../bot/bot-inbound.queue';
import { RequestContextService } from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeE164 } from '../common/phone.util';
import { hashChatId, withinBotRateLimit } from '../bot/bot-rate-limit';
import { recordBotStats } from '../bot/bot-stats';
import {
  buildBotTurn,
  emitBotTurn,
  type BotTurnOutcome,
  type BotTurnReason,
} from '../bot/bot-turn-event';
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

  /**
   * Adjuntos seguidos (sin texto en medio) que disparan el handoff a una
   * persona. El primero recibe el aviso de "solo leo texto"; al segundo
   * asumimos que el paciente no puede o no quiere escribir.
   */
  private static readonly MEDIA_HANDOFF_THRESHOLD = 2;

  /** Ventana del contador de adjuntos seguidos. */
  private static readonly MEDIA_COUNT_TTL_SEC = 86_400;

  private static readonly MEDIA_HANDOFF_TEXT =
    'Te paso con una persona del equipo para escucharte.';

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
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly waha: WahaService,
    @Inject(BOT_INBOUND_QUEUE_TOKEN) private readonly inbound: Queue,
    private readonly ctx: RequestContextService,
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
   * `jobId` del job de `bot-inbound`. **No puede llevar `:`**: BullMQ lo
   * rechaza (`Custom Id cannot contain :`, `job.js` — sólo tolera exactamente
   * tres segmentos, por compat con repeatables viejos, y eso está marcado para
   * desaparecer). Con la clave de dedup tal cual, que tiene cuatro, el `add`
   * lanzaba en TODOS los mensajes de texto: 500 al webhook, WAHA reintentando
   * contra un fallo determinista y el paciente sin respuesta — con el health
   * check en verde, porque el job nunca llegaba a existir.
   *
   * La `session` va dentro del hash, no de prefijo: el id tiene que seguir
   * acotado al tenant o una clínica podría suprimir el mensaje de otra.
   */
  private dedupJobId(
    session: string,
    from: string,
    messageId: string,
  ): string {
    const digest = createHash('sha256')
      .update(`${session}|${from}|${messageId}`)
      .digest('hex');
    return `waha-evt-${digest}`;
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
   * Lo aplican los DOS caminos del webhook, y por el mismo motivo: ninguno
   * hace ya el trabajo caro dentro de la request. Los adjuntos escriben en
   * `Conversation` y `Message` y mandan un `sendText`; los de texto encolan en
   * Redis. Sin cota, un flood escribe sin límite en ambos casos (justo el
   * ataque que motivó el ADR) y, con el token del webhook comprometido, saca
   * un `sendText` por request variando `from`, saltándose el cap horario que
   * protege el número de la clínica.
   *
   * Comparte claves y presupuesto con el bot — ver `bot/bot-rate-limit.ts`.
   */
  /**
   * Registra un turno de los caminos que NO pasan por el worker: adjuntos y
   * mensajes descartados. Sin esto, la métrica contaría sólo lo que llega al
   * bot y la tasa de descarte sería invisible justo cuando más importa (un
   * flood, o una clínica que sólo recibe audios).
   *
   * Argumentos con nombre a propósito: `clinicId` y `chatId` son dos strings
   * seguidos, y confundirlos atribuiría las métricas de un paciente a la
   * clínica equivocada sin que nada se queje.
   *
   * `log: false` cuenta pero no emite la línea. Es para el camino de la cota:
   * el sentido del rate-limit es dejar de hacer trabajo durante un flood, y
   * una línea por mensaje descartado convierte el flood en coste de ingesta.
   * El contador agregado ya da la señal que interesa (la tasa de descarte).
   */
  private recordTurn(input: {
    clinicId: string;
    chatId: string;
    timezone: string;
    outcome: BotTurnOutcome;
    latencyMs?: number;
    reasonCode?: BotTurnReason;
    turn?: Parameters<typeof buildBotTurn>[0]['turn'];
    log?: boolean;
  }): void {
    const event = buildBotTurn({
      clinicId: input.clinicId,
      chatHash: hashChatId(input.chatId, input.clinicId),
      outcome: input.outcome,
      latencyMs: input.latencyMs,
      requestId: this.ctx.get('requestId'),
      reasonCode: input.reasonCode,
      turn: input.turn,
    });
    if (input.log !== false) emitBotTurn(this.logger, event);
    void recordBotStats(
      this.redis,
      this.logger,
      event,
      input.timezone,
    ).catch(() => undefined);
  }

  private withinRateLimit(
    clinicId: string,
    chatId: string,
    scope: 'bot' | 'media',
  ): Promise<boolean> {
    return withinBotRateLimit(this.redis, this.logger, {
      clinicId,
      chatId,
      scope,
    });
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
    /**
     * `true` si el mensaje acabó derivando la conversación a una persona.
     * Lo devuelve para que el evento `bot.turn` lo refleje: es una derivación
     * de verdad y cuenta para la tasa que ve la clínica en su panel.
     */
  }): Promise<{ handoff: boolean }> {
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

    if (convo.state === 'HUMAN') return { handoff: false };

    // Segundo adjunto seguido: el paciente no está escribiendo, y repetirle el
    // mismo aviso cada 6 h lo deja sin atención (el hilo se queda en BOT y no
    // aparece en el filtro de triaje del panel). Lo pasamos a una persona.
    const consecutive = await this.bumpMediaCount(clinic.id, chatId);
    if (consecutive >= WebhookController.MEDIA_HANDOFF_THRESHOLD) {
      // Reiniciamos la racha para no repetir el handoff en cada adjunto
      // siguiente: el tercero vuelve a contar como primero y cae en el aviso,
      // que su propio throttle de 6 h ya tiene silenciado.
      await this.resetMediaCount(clinic.id, chatId);
      let escalated = false;
      if (convo.state !== 'NEEDS_HUMAN') {
        await this.prisma.conversation.update({
          where: { id: convo.id },
          data: {
            state: 'NEEDS_HUMAN',
            flowStep: null,
            flowData: Prisma.JsonNull,
          },
        });
        await this.sendAndPersist(
          clinic,
          chatId,
          convo.id,
          WebhookController.MEDIA_HANDOFF_TEXT,
        );
        escalated = true;
      }
      return { handoff: escalated };
    }

    if (!(await this.claimMediaNotice(clinic.id, chatId))) {
      return { handoff: false };
    }

    const text = caption
      ? WebhookController.MEDIA_NOTICE_TEXT_WITH_CAPTION
      : WebhookController.MEDIA_NOTICE_TEXT;

    // El aviso es best-effort y NO relanza: lo durable (Conversation + Message
    // IN) ya está escrito. Si relanzáramos, WAHA reintentaría, el
    // `message.create` del IN duplicaría la fila en la bandeja y el throttle ya
    // consumido dejaría al paciente sin aviso durante 6 h. Liberamos la clave
    // para poder avisar en el próximo adjunto.
    if (!(await this.sendAndPersist(clinic, chatId, convo.id, text))) {
      await this.releaseMediaNotice(clinic.id, chatId);
    }
    return { handoff: false };
  }

  /**
   * Manda el texto y persiste el `Message OUT`. Devuelve `false` si falló.
   *
   * NO relanza a propósito: lo durable (Conversation + Message IN) ya está
   * escrito. Relanzar haría que WAHA reintentara, que `message.create`
   * duplicara la fila IN en la bandeja (no es idempotente) y que el throttle
   * ya consumido dejara al paciente sin aviso durante 6 h.
   */
  private async sendAndPersist(
    clinic: { id: string; wahaSession: string },
    chatId: string,
    convoId: string,
    text: string,
  ): Promise<boolean> {
    try {
      await this.waha.sendText(clinic.wahaSession, chatId, text);
      await this.prisma.message.create({
        data: { conversationId: convoId, direction: 'OUT', body: text },
      });
      return true;
    } catch (e) {
      this.logger.warn(
        `mensaje automático no enviado clinic=${clinic.id}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Cuenta adjuntos SEGUIDOS (sin texto en medio) y devuelve el total.
   * Se reinicia con `resetMediaCount` en cuanto entra un mensaje de texto, así
   * que "audio, texto, audio" nunca llega a 2.
   *
   * Fail-open devolviendo 1 si Redis no está: ante la duda, tratarlo como
   * primer adjunto (aviso normal) en vez de derivar a una persona por error.
   */
  private async bumpMediaCount(
    clinicId: string,
    chatId: string,
  ): Promise<number> {
    const key = `bot:media-count:${clinicId}:${chatId}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, WebhookController.MEDIA_COUNT_TTL_SEC);
      }
      return count;
    } catch (e) {
      this.logger.warn(
        `contador de adjuntos falló (redis) clinic=${clinicId}: ${(e as Error).message}`,
      );
      return 1;
    }
  }

  /**
   * Un mensaje de texto rompe la racha de adjuntos. Best-effort: si Redis
   * falla, lo peor que pasa es un handoff de más, que es el lado seguro.
   */
  private async resetMediaCount(
    clinicId: string,
    chatId: string,
  ): Promise<void> {
    try {
      await this.redis.del(`bot:media-count:${clinicId}:${chatId}`);
    } catch (e) {
      this.logger.warn(
        `no se pudo reiniciar el contador de adjuntos clinic=${clinicId}: ${(e as Error).message}`,
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
      // No registra `bot.turn`, al revés que el mismo caso en el worker, y es
      // deliberado: aquí todavía no se ha parseado el `payload`, así que no hay
      // `chatId` con el que construir el seudónimo. Tampoco se pierde gran
      // cosa: una clínica suspendida no tiene a nadie mirando su panel. En el
      // worker sí importa, porque allí significa que se suspendió DESPUÉS de
      // encolar, y eso explica mensajes que el paciente mandó y nadie contestó.
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
      const jobId = messageId
        ? this.dedupJobId(session, from, messageId)
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
        if (!(await this.withinRateLimit(clinic.id, from, 'media'))) {
          this.recordTurn({
            clinicId: clinic.id,
            chatId: from,
            timezone: clinic.timezone,
            outcome: 'skipped',
            reasonCode: 'rate-limit',
            log: false,
          });
          return { ok: true };
        }
        const mediaStartedAt = Date.now();
        let handoff = false;
        try {
          ({ handoff } = await this.handleUnsupportedMessage({
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
          }));
        } catch (e) {
          if (dedupKey) await this.releaseMessage(dedupKey);
          throw e;
        }
        // Un adjunto es un turno igual: el paciente escribió y le
        // respondimos. Sin esto, las notas de voz serían un agujero en las
        // métricas justo donde más falta hace saber cuántas llegan.
        // `handoff` va al evento y al contador: derivar por audios seguidos es
        // una derivación de verdad, y es la única que hoy alimenta la tasa que
        // la clínica ve en su panel (el resto la cableará `bot.service.ts`).
        this.recordTurn({
          clinicId: clinic.id,
          chatId: from,
          timezone: clinic.timezone,
          outcome: 'unsupported',
          latencyMs: Date.now() - mediaStartedAt,
          turn: { handoff },
        });
        return { ok: true };
      }

      // Un mensaje de texto rompe la racha de adjuntos seguidos: el paciente
      // SÍ puede escribir, así que no hay que derivarlo a una persona.
      await this.resetMediaCount(clinic.id, from);

      // Rate-limit del ADR 0007 ANTES de encolar. Es imprescindible que esté
      // aquí y no sólo dentro del bot: `handleIncoming` ahora corre en el
      // worker, o sea DESPUÉS de escribir en Redis, así que sin esta cota
      // cualquiera con el token del webhook podría llenar Redis a request por
      // request — y con Redis lleno se caen también el dedup, los tokens de la
      // página pública y la cola de recordatorios.
      //
      // OJO, deuda acordada: `handleIncoming` todavía vuelve a consumir
      // presupuesto sobre LAS MISMAS claves, así que hasta que se le quite
      // (bot.service.ts es de otra sesión) cada mensaje cuenta dos veces y los
      // límites efectivos son la mitad: ~7/min por chat y 250/h por clínica.
      // Es el lado seguro del error, pero hay que cerrarlo.
      if (!(await this.withinRateLimit(clinic.id, from, 'bot'))) {
        this.recordTurn({
          clinicId: clinic.id,
          chatId: from,
          timezone: clinic.timezone,
          outcome: 'skipped',
          reasonCode: 'rate-limit',
          log: false,
        });
        return { ok: true };
      }

      // Encolar y responder 200 al instante. Antes esperábamos a que el bot
      // terminara —con el LLM de por medio, segundos— y WAHA reintentaba el
      // webhook por timeout: el mismo mensaje acababa procesado dos veces.
      //
      // `jobId` = la clave de dedup. Es una red secundaria: mientras el job
      // exista, BullMQ descarta el duplicado por su cuenta. No sustituye al
      // `SET NX` de 24 h, porque el job se borra por edad (ver
      // BOT_INBOUND_JOB_OPTIONS) y a partir de ahí el mismo id volvería a
      // entrar.
      const jobData: BotInboundJobData = {
        clinicId: clinic.id,
        chatId: from,
        phone,
        lid,
        contactName,
        // Truncado antes de que el texto entre en Redis, igual que el pie de
        // foto: el body-parser admite 1 MB por request.
        text: body.slice(0, MAX_INBOUND_TEXT_CHARS),
        timezone: clinic.timezone,
        requestId: this.ctx.get('requestId'),
      };
      try {
        await this.inbound.add(
          BOT_INBOUND_JOB,
          jobData,
          jobId ? { jobId } : {},
        );
      } catch (e) {
        // Encolar es lo único que puede fallar aquí, y si falla el mensaje se
        // pierde: soltamos el dedup y relanzamos para que WAHA reintente.
        // A partir de que el job existe, los reintentos son de BullMQ.
        if (dedupKey) await this.releaseMessage(dedupKey);
        throw e;
      }
    }

    return { ok: true };
  }
}
