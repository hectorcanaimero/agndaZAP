import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Clinic, Conversation, Prisma, Service } from '@prisma/client';
import Redis from 'ioredis';
import { DateTime } from 'luxon';
import { FollowUpsService } from '../follow-ups/follow-ups.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../public/rate-limit.guard';
import { RemindersService } from '../reminders/reminders.service';
import { AvailabilityService, Slot } from '../scheduling/availability.service';
import { SchedulingSessionService } from '../scheduling/scheduling-session.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { WahaService } from '../whatsapp/waha.service';
import { hashChatId, withinBotRateLimit } from './bot-rate-limit';
import { Intent, IntentService } from './intent.service';
import {
  asksForSomethingElse,
  isAmbiguousYes,
  isBareGreeting,
  isCourtesyClosing,
  isFlowAbort,
  isHumanEscape,
  normalizeText,
  parseReminderReply,
  ReminderReplyAction,
  startsWithAny,
  stripGreeting,
} from './message-matching';

/** Pasos de la FSM de agendamiento, persistidos en Conversation.flowStep. */
type FlowStep =
  | 'ASK_SERVICE'
  | 'ASK_PROFESSIONAL'
  | 'ASK_SLOT'
  | 'ASK_NAME'
  | 'CONFIRM'
  // Sub-FSM de follow-up post-atención (satisfacción). El processor deja la
  // conversation en AWAITING_NPS_SCORE al mandar el prompt; el paciente
  // responde 1-5, opcionalmente sigue con un comentario. Ver ADR 0012.
  | 'AWAITING_NPS_SCORE'
  | 'AWAITING_NPS_COMMENT';

/** Datos acumulados durante la FSM, persistidos en Conversation.flowData. */
interface FlowData {
  serviceId?: string;
  professionalId?: string;
  startAtISO?: string;
  /** Slots ofrecidos en el paso ASK_SLOT — usamos el índice para resolver la elección. */
  offeredSlots?: string[]; // ISO strings
  /** Copia inmutable de la lista mostrada en el último ASK_* para reparsear. */
  choices?: Array<{ id: string; label: string }>;
  /** Nombre del paciente capturado en ASK_NAME (solo si no existía en DB). */
  patientName?: string;
  /** Sub-FSM de feedback: id de la cita que estamos puntuando. */
  feedbackAppointmentId?: string;
  /** Sub-FSM de feedback: score ya capturado, esperando comentario opcional. */
  feedbackScore?: number;
}

type FlowConfirmAction = ReminderReplyAction | 'NO';

/**
 * Orquestador del bot. Combina:
 *  - reglas deterministas (confirmaciones por palabra clave — barato y confiable),
 *  - detección de intención por LLM (arranque de flujos),
 *  - FSM de agendamiento (servicio → profesional → slot → confirmación explícita).
 *
 * El estado de la FSM vive en Conversation.flowStep + Conversation.flowData;
 * cada mensaje entrante lo procesa ANTES de re-detectar intención, así el flujo
 * es retomable si el paciente responde tarde.
 */
@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly waha: WahaService,
    private readonly reminders: RemindersService,
    private readonly followUps: FollowUpsService,
    private readonly intent: IntentService,
    private readonly availability: AvailabilityService,
    private readonly scheduling: SchedulingService,
    private readonly schedulingSessions: SchedulingSessionService,
    private readonly knowledge: KnowledgeService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Genera un link de agendamiento web atado a esta conversación WA y lo
   * devuelve como URL absoluta lista para mandar por WhatsApp.
   *
   * Uso: cuando el bot decide escalar a la web (típicamente porque llegó por
   * `@lid` y no tenemos phone, o porque la FSM se enredó y preferimos que el
   * paciente use el form gráfico). El token expira en 30 min (default del
   * SchedulingSessionService) — suficiente para completar el flujo sin
   * dejarlo abierto indefinidamente.
   *
   * URL shape: `{WEB_BASE_URL}/{locale}/agendar/{slug}?t={token}`.
   *   - `WEB_BASE_URL` viene de env; en prod típicamente `https://showly.us`.
   *     Sin trailing slash. Default `http://localhost:3000` para dev.
   *   - `locale` sale del Clinic (soporte i18n en la URL).
   *
   * Devuelve la URL. El caller decide cómo redactarla en el mensaje WA.
   */
  async buildSchedulingLink(
    convo: Pick<Conversation, 'id' | 'phone' | 'lid' | 'contactName'>,
    clinic: Pick<Clinic, 'id' | 'slug' | 'locale'>,
  ): Promise<string> {
    const { token } = await this.schedulingSessions.create({
      conversationId: convo.id,
      clinicId: clinic.id,
      clinicSlug: clinic.slug,
      phone: convo.phone,
      lid: convo.lid,
      name: convo.contactName,
    });
    const baseUrl = (
      process.env.WEB_BASE_URL ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    return `${baseUrl}/${clinic.locale}/agendar/${clinic.slug}?t=${token}`;
  }

  /**
   * Actualiza `avatarUrl` + `avatarFetchedAt` de una conversación en background.
   * Silencia errores (WAHA caido, contacto sin foto) — el fallback en frontend
   * son las iniciales del contactName / phone.
   */
  private async refreshAvatar(
    convoId: string,
    wahaSession: string,
    chatId: string,
  ): Promise<void> {
    try {
      const url = await this.waha.getContactAvatar(wahaSession, chatId);
      await this.prisma.conversation.update({
        where: { id: convoId },
        data: {
          avatarUrl: url,
          avatarFetchedAt: DateTime.now().toJSDate(),
        },
      });
    } catch (e) {
      this.logger.warn(
        `refreshAvatar falló convoId=${convoId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Pools de mensajes default cuando `clinic.bot*` es NULL. Cada `key`
   * mapea a un ARRAY de variantes; `pickVariant()` elige una al azar en
   * cada respuesta.
   *
   * WHY pool: WhatsApp/Meta detecta bots no oficiales por patrones como
   * "mismo string palabra por palabra en N chats distintos". Rotar
   * variantes reduce esa huella. El costo es mínimo (~4 strings por key)
   * y sin migración — los overrides tenant (`clinic.botGreeting`, etc.)
   * siguen siendo single-line y ganan sobre el pool.
   *
   * Placeholders soportados: `{clinicName}`, `{patientName}`, `{link}`
   * (página pública de agendamiento, sin token). Para `confirmAppointment`
   * además: `{status}`, `{when}`, `{address}`, `{service}`, `{professional}`.
   */
  private static readonly DEFAULT_BOT_MESSAGES = {
    greeting: [
      '¡Hola! Soy el asistente de {clinicName}. ¿Quieres agendar una cita? Escríbeme *agendar* y lo hacemos aquí mismo, o reserva en línea: {link}\n\nSi tienes otra duda, cuéntame.',
      'Hola 👋 Soy el asistente de {clinicName}. Escríbeme *agendar* para reservar tu cita por aquí, o hazlo en línea: {link}\n\nTambién puedo responder tus dudas.',
      '¡Hola! Gracias por escribir a {clinicName}. Para reservar una cita escríbeme *agendar*, o usa nuestra página: {link}\n\n¿En qué te ayudo?',
    ],
    /**
     * Saludo cuando el número ya tiene una cita próxima. Arquitectura de
     * elección con contexto: en vez de ofrecer "agendar", ofrecemos las
     * acciones que tienen sentido sobre ESA cita. Placeholders extra:
     * `{service}`, `{when}`, `{statusLine}`.
     */
    greetingWithAppointment: [
      'Hola{patientName}. {statusLine}\n\nResponde *SÍ* para confirmarla, *REAGENDAR* para moverla o *CANCELAR* si no puedes ir.\n\nSi necesitas otra cosa, cuéntame.',
    ],
    fallback: [
      'Puedo ayudarte a *agendar*, *reagendar* o *cancelar* una cita, o responder dudas. ¿Qué necesitas?',
      'Cuéntame qué necesitas: puedo *agendar*, *reagendar* o *cancelar* una cita, o responder dudas.',
      'Estoy para ayudarte con tu cita. Puedes escribir *agendar*, *reagendar*, *cancelar*, o preguntarme algo.',
    ],
    handoff: [
      'Enseguida te atiende una persona del equipo. 🙏',
      'Te derivo con alguien del equipo, enseguida te responden. 🙏',
    ],
    /**
     * Cierre de cortesía ("ok, gracias"). Sin LLM y sin volver a ofrecer el
     * menú: el paciente está cerrando la conversación, no pidiendo algo.
     * Antes esto caía en el parser de recordatorios y respondía
     * "No encontré una cita próxima…" (ver B2 del análisis del bot).
     */
    closing: [
      '¡Con gusto! Si necesitas algo más, escríbeme. 🙌',
      'De nada. Aquí estoy si necesitas algo más. 🙌',
      '¡Un gusto ayudarte! Cualquier cosa, escríbeme. 🙌',
    ],
    /**
     * Cierre con acción tras responder una duda (M6). Solo se anexa cuando el
     * paciente NO tiene cita próxima: si ya tiene una, invitarlo a agendar es
     * ruido. `{link}` es la página pública SIN token — responder una pregunta
     * no debe escribir una `SchedulingSession` en DB.
     */
    ctaAfterAnswer: [
      '¿Quieres agendar? Escríbeme *agendar* y lo hacemos aquí, o reserva en línea: {link}',
      'Si quieres una cita, escríbeme *agendar* o resérvala aquí: {link}',
      'Cuando quieras agendar, escríbeme *agendar* o usa nuestra página: {link}',
    ],
    confirmAppointment: [
      '✅ Listo. Tu cita de {service} con {professional} quedó {status} para el {when} en {clinicName}.{address}\n\nTe recordaré antes de la cita. Si necesitas cambiarla, escríbeme *reagendar*.',
      '¡Perfecto! Reservé tu cita de {service} con {professional} para el {when} en {clinicName}.{address}\n\nTe avisaré antes para recordártela. Cualquier cambio, escríbeme *reagendar*.',
    ],
  } as const;

  /**
   * Aviso de asistente automático (ADR 0004 §7). Se agrega SIEMPRE al final
   * del greeting — también cuando la clínica personaliza `botGreeting` —
   * porque es un requisito de compliance (LGPD/GDPR), no un texto editable.
   * Es corto a propósito: la lista de proveedores de IA vive en el texto de
   * consentimiento del form público y en la política de privacidad, no en el
   * saludo. Incluye el escape a humano para que el paciente sepa salir del bot.
   */
  static readonly AI_DISCLOSURE =
    'Soy un asistente automático. Si prefieres hablar con una persona, escribe *humano*.';

  /** Ventana en la que un "sí" suelto se lee como respuesta a un recordatorio. */
  private static readonly REMINDER_REPLY_WINDOW_H = 48;

  /**
   * Elige una variante al azar de un array. `Math.random` es suficiente:
   * el objetivo es "no siempre el mismo string", no criptografía. Un
   * PRNG sesgado no tiene impacto de seguridad acá.
   */
  private pickVariant<T>(variants: readonly T[]): T {
    return variants[Math.floor(Math.random() * variants.length)]!;
  }

  /**
   * Resuelve el mensaje del bot para una clínica, aplicando el custom si
   * existe o eligiendo una variante random del pool default. Reemplaza
   * placeholders `{clinicName}` y `{patientName}`.
   *
   * Contrato del override: si `clinic.botGreeting` (u otro) está seteado,
   * se usa TAL CUAL — es una única cadena, no rota. Motivo: mantener la
   * migración fuera de scope y respetar el mental model del owner
   * (setea un mensaje, ve ese mensaje). Si en el futuro se quiere pool
   * custom, el campo pasa a `Json` con una migración.
   */
  private resolveBotMessage(
    clinic: Pick<
      Clinic,
      'name' | 'slug' | 'locale' | 'botGreeting' | 'botFallback' | 'botHandoffMsg'
    >,
    key: 'greeting' | 'fallback' | 'handoff',
    ctx?: { patientName?: string | null },
  ): string {
    const customMap = {
      greeting: clinic.botGreeting,
      fallback: clinic.botFallback,
      handoff: clinic.botHandoffMsg,
    } as const;
    const template =
      customMap[key] || this.pickVariant(BotService.DEFAULT_BOT_MESSAGES[key]);
    const rendered = template
      .replace(/\{clinicName\}/g, clinic.name)
      .replace(/\{patientName\}/g, ctx?.patientName ?? '')
      .replace(/\{link\}/g, this.publicSchedulingUrl(clinic));
    return key === 'greeting'
      ? `${rendered}\n\n${BotService.AI_DISCLOSURE}`
      : rendered;
  }

  /**
   * Cierre con acción (M6): tras responder una duda, invita a agendar.
   *
   * No se anexa cuando:
   *  - el paciente YA tiene una cita próxima — invitarlo a agendar otra es
   *    ruido, y encima confunde a quien creía estar preguntando por la suya;
   *  - el mensaje anterior del bot ya llevaba el link. Repetir la misma
   *    llamada a la acción en cada respuesta es el patrón que delata a un bot,
   *    y el paciente que hace tres preguntas seguidas la leería tres veces.
   *
   * El link es el público SIN token: responder una pregunta no debe escribir
   * una `SchedulingSession` en DB.
   */
  private async withClosingCta(
    clinic: Clinic,
    convo: Conversation,
    answer: string,
  ): Promise<string> {
    // Mismo helper que usa el resto del bot para resolver la cita del
    // paciente, así que hereda el orden de resolución sin duplicarlo.
    if (convo.phone) {
      const upcoming = await this.findUpcomingAppointment(
        clinic.id,
        convo.phone,
      );
      if (upcoming) return answer;
    }

    const link = this.publicSchedulingUrl(clinic);
    const lastOut = await this.prisma.message.findFirst({
      where: { conversationId: convo.id, direction: 'OUT' },
      orderBy: { createdAt: 'desc' },
      select: { body: true },
    });
    if (lastOut?.body.includes(link)) return answer;

    const cta = this.pickVariant(
      BotService.DEFAULT_BOT_MESSAGES.ctaAfterAnswer,
    ).replace(/\{link\}/g, link);
    return `${answer}\n\n${cta}`;
  }

  /**
   * URL pública de agendamiento SIN token (`/{locale}/agendar/{slug}`). Se
   * usa en el saludo: no crea SchedulingSession (cada "hola" no debe escribir
   * en DB). El link tokenizado con prefill sigue en `buildSchedulingLink`.
   */
  private publicSchedulingUrl(clinic: Pick<Clinic, 'slug' | 'locale'>): string {
    const baseUrl = (
      process.env.WEB_BASE_URL ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    return `${baseUrl}/${clinic.locale}/agendar/${clinic.slug}`;
  }

  /**
   * Saludo con contexto: el número ya tiene una cita próxima. Ofrece las
   * acciones sobre esa cita (confirmar / reagendar / cancelar) en vez del
   * menú genérico. Devuelve null si no hay cita (→ saludo normal).
   */
  private async greetingWithAppointment(
    clinic: Clinic,
    phone: string | null,
  ): Promise<string | null> {
    if (!phone) return null;
    const appt = await this.findUpcomingAppointment(clinic.id, phone);
    if (!appt) return null;
    const when = this.formatWhen(appt.startAt.toISOString(), clinic);
    const service = appt.service?.name ?? 'consulta';
    const statusLine =
      appt.status === 'CONFIRMADA'
        ? `Tu cita de ${service} del ${when} ya está confirmada.`
        : `Veo que tienes una cita de ${service} el ${when}.`;
    const patientName = appt.patient?.name ? ` ${appt.patient.name}` : '';
    const template = this.pickVariant(
      BotService.DEFAULT_BOT_MESSAGES.greetingWithAppointment,
    );
    const rendered = template
      .replace(/\{patientName\}/g, patientName)
      .replace(/\{statusLine\}/g, statusLine);
    return `${rendered}\n\n${BotService.AI_DISCLOSURE}`;
  }

  /**
   * Arma el mensaje de confirmación post-agendamiento eligiendo una
   * variante random del pool `confirmAppointment`. Placeholders:
   *  - `{status}`      → "confirmada" | "agendada"
   *  - `{when}`        → fecha formateada (Luxon)
   *  - `{clinicName}`  → nombre de la clínica
   *  - `{address}`     → línea "\nDirección: X" (o string vacío)
   *
   * Sin custom-per-clinic todavía: si aparece la necesidad se agrega un
   * campo `Clinic.botConfirm` en una migración aparte. Ver deuda técnica.
   */
  private resolveConfirmMessage(input: {
    status: string;
    when: string;
    clinicName: string;
    address: string;
    service: string;
    professional: string;
  }): string {
    const template = this.pickVariant(
      BotService.DEFAULT_BOT_MESSAGES.confirmAppointment,
    );
    return template
      .replace(/\{status\}/g, input.status)
      .replace(/\{when\}/g, input.when)
      .replace(/\{clinicName\}/g, input.clinicName)
      .replace(/\{address\}/g, input.address)
      .replace(/\{service\}/g, input.service)
      .replace(/\{professional\}/g, input.professional);
  }

  async handleIncoming(input: {
    clinicId: string;
    chatId: string;
    /** E.164 con `+` (ver `normalizeE164`), o null si `chatId` es un @lid. */
    phone: string | null;
    /** LID de WhatsApp sin sufijo, si el chatId venia como @lid. */
    lid?: string | null;
    /** pushName visible del contacto (puede cambiar entre mensajes). */
    contactName?: string | null;
    text: string;
  }): Promise<void> {
    const { clinicId, chatId, phone, lid, contactName, text } = input;

    // Rate-limit + circuit breaker del ADR 0007. Mismas claves y presupuesto
    // que el camino de adjuntos del webhook: ver `bot-rate-limit.ts`.
    if (!(await withinBotRateLimit(this.redis, this.logger, {
      clinicId,
      chatId,
      scope: 'bot',
    }))) {
      return;
    }

    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
    });

    // Upsert de la conversación. En update solo tocamos `contactName` si vino
    // uno nuevo (WhatsApp permite cambiarlo) — evita clobbears innecesarios.
    // `phone` también se refresca cuando lo conocemos: conversaciones creadas
    // antes de normalizar a E.164 (sin `+`) quedan corregidas al próximo
    // mensaje, sin migración de datos.
    const convo = await this.prisma.conversation.upsert({
      where: { clinicId_chatId: { clinicId, chatId } },
      create: {
        clinicId,
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
      data: { conversationId: convo.id, direction: 'IN', body: text },
    });

    // Avatar: refresh en background si nunca lo trajimos o si expiró (>24h).
    // Fire-and-forget: no bloqueamos el pipeline del bot por un avatar.
    const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;
    const needsAvatar =
      !convo.avatarFetchedAt ||
      Date.now() - convo.avatarFetchedAt.getTime() > AVATAR_TTL_MS;
    if (needsAvatar) {
      // No await — errores se loggean dentro de refreshAvatar.
      void this.refreshAvatar(convo.id, clinic.wahaSession, chatId);
    }

    // Si un humano tomó la conversación, el bot no responde.
    if (convo.state === 'HUMAN') return;

    const normalized = normalizeText(text);

    // Escape universal a humano: desde CUALQUIER paso (con o sin FSM) el paciente
    // puede pedir hablar con una persona y salimos del bot inmediatamente.
    // Palabras sueltas (humano, operador, asesor…) y frases explícitas; ver
    // `isHumanEscape`. `persona` a secas NO deriva (B3). Reseteamos FSM y
    // marcamos NEEDS_HUMAN para la bandeja.
    if (isHumanEscape(normalized)) {
      await this.markNeedsHuman(convo.id);
      await this.reply(
        clinic.wahaSession,
        chatId,
        convo.id,
        this.resolveBotMessage(clinic, 'handoff'),
      );
      return;
    }

    // 1) FSM activa: procesamos el paso ANTES de tocar el LLM.
    if (convo.flowStep) {
      await this.handleFlowStep(clinic, convo, normalized, text);
      return;
    }

    // 1.5) Saludo — solo si NO hay FSM activa. Cortés y barato: no gasta LLM.
    // El saludo se RECORTA del mensaje en vez de consumirlo entero: si después
    // del "hola" viene contenido real, seguimos la escalera con el texto
    // recortado (recordatorio → clasificador → RAG). Ver B1 del análisis.
    const { matched: greeted, rest } = stripGreeting(text, clinic.name);
    const effectiveText = greeted && rest ? rest : text;
    const effectiveNormalized = greeted ? normalizeText(rest) : normalized;

    // 1.6) Cierre de cortesía ("ok, gracias"): respuesta corta, sin LLM y sin
    // pasar por el parser de recordatorios (que respondía "no encontré cita").
    if (isCourtesyClosing(effectiveNormalized)) {
      // Único pool que no pasa por `resolveBotMessage`: no hay columna
      // `Clinic.botClosing` que overridear ni placeholders que renderizar. Si
      // aparece la necesidad, se agrega el campo y se mueve al patrón normal.
      await this.reply(
        clinic.wahaSession,
        chatId,
        convo.id,
        this.pickVariant(BotService.DEFAULT_BOT_MESSAGES.closing),
      );
      return;
    }

    if (greeted && isBareGreeting(effectiveNormalized)) {
      const contextual = await this.greetingWithAppointment(clinic, phone);
      await this.reply(
        clinic.wahaSession,
        chatId,
        convo.id,
        contextual ?? this.resolveBotMessage(clinic, 'greeting'),
      );
      return;
    }

    // 2) Confirmaciones deterministas (recordatorios) — solo si NO hay FSM.
    // Deben resolverse ANTES de invocar el LLM: el recordatorio pide responder
    // SÍ / REAGENDAR / CANCELAR, y esas palabras no pueden depender del modelo.
    const reminderAction = parseReminderReply(effectiveNormalized);
    if (reminderAction) {
      // `cancelar` / `reagendar` / `confirmo` son verbos explícitos: pasan
      // siempre (también sin `phone` — caso @lid — donde el handler deriva a
      // recepción). `si` / `ok` / `dale` son ambiguos y necesitan contexto.
      const ambiguous =
        reminderAction === 'YES' && isAmbiguousYes(effectiveNormalized);

      if (!ambiguous || !phone) {
        await this.handleReminderReply(clinic, convo, reminderAction, phone);
        return;
      }

      // "sí, quiero agendar una cita" no es una confirmación: es un pedido que
      // arranca con "sí". Si el mensaje nombra otra cosa (agendar, precio,
      // cancelar…), va al clasificador aunque haya un recordatorio esperando.
      if (!asksForSomethingElse(effectiveNormalized)) {
        if (await this.hasConfirmationContext(clinic.id, convo.id, phone)) {
          await this.handleReminderReply(clinic, convo, reminderAction, phone);
          return;
        }
        // "sí" suelto sin nada que confirmar: respondemos el menú. Ni "no
        // encontré cita" (suena a error) ni "responde *SÍ*" (sería un bucle).
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          this.resolveBotMessage(clinic, 'fallback'),
        );
        return;
      }
    }

    // 3) Detección de intención con LLM.
    const intent = await this.intent.detect(effectiveText, clinic.locale);
    switch (intent) {
      case Intent.HABLAR_HUMANO:
        await this.markNeedsHuman(convo.id);
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          this.resolveBotMessage(clinic, 'handoff'),
        );
        break;

      case Intent.AGENDAR:
        await this.startFlow(clinic, convo);
        break;

      case Intent.REPROGRAMAR:
        await this.handleReminderReply(clinic, convo, 'RESCHEDULE', phone);
        break;

      case Intent.CANCELAR:
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          'Para cancelar tu próxima cita, responde *CANCELAR*. No voy a cancelarla sin esa confirmación explícita.',
        );
        break;

      case Intent.CONFIRMAR:
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          'Para confirmar tu próxima cita, responde *SÍ*.',
        );
        break;

      case Intent.PREGUNTA_FAQ: {
        // RAG sobre FaqChunk: si hay match confiable → respondemos con el
        // texto sintetizado por el LLM desde las fuentes. Si no → handoff a
        // humano (política "prefiero handoff que alucinar").
        const result = await this.knowledge.answer({
          clinicId,
          question: effectiveText,
          locale: clinic.locale,
          tone: clinic.botTone, // custom per-tenant desde /panel/ajustes
          // Teléfono de la conversación (el que WAHA reporta, no uno
          // declarado): habilita la parte de "tu próxima cita" del bloque de
          // hechos. `ClinicFactsService` lo filtra por clinicId + phone. Va
          // `convo.phone` y no el `phone` del mensaje porque el upsert conserva
          // el número ya conocido si este mensaje llegó por @lid.
          phone: convo.phone,
        });
        if (result) {
          await this.reply(
            clinic.wahaSession,
            chatId,
            convo.id,
            await this.withClosingCta(clinic, convo, result.answer),
          );
        } else {
          await this.markNeedsHuman(convo.id);
          await this.reply(
            clinic.wahaSession,
            chatId,
            convo.id,
            this.resolveBotMessage(clinic, 'handoff'),
          );
        }
        break;
      }

      default:
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          this.resolveBotMessage(clinic, 'fallback'),
        );
    }
  }

  // ─────────────────────────── FSM: entrada ───────────────────────────

  /** Arranca la FSM: lista los servicios activos y setea flowStep=ASK_SERVICE. */
  private async startFlow(clinic: Clinic, convo: Conversation): Promise<void> {
    const services = await this.prisma.service.findMany({
      where: { clinicId: clinic.id, active: true },
      orderBy: { name: 'asc' },
    });

    if (services.length === 0) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Por ahora no tenemos servicios cargados. Escríbeme más tarde o escribe *humano* para hablar con una persona.',
      );
      return;
    }

    // Si hay un solo servicio, lo pre-seleccionamos y saltamos al siguiente paso.
    if (services.length === 1) {
      const only = services[0];
      const nextData: FlowData = { serviceId: only.id };
      await this.advanceToProfessional(clinic, convo, nextData, only);
      return;
    }

    const choices = services.map((s) => ({
      id: s.id,
      label: `${s.name} – ${s.durationMin} min`,
    }));
    const data: FlowData = { choices };
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { flowStep: 'ASK_SERVICE', flowData: data as object },
    });
    const list = choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      `¡Con gusto te agendo! Primero, ¿qué servicio necesitas?\n\n${list}\n\nResponde con el número o el nombre.`,
    );
  }

  // ─────────────────────────── FSM: dispatch ───────────────────────────

  private async handleFlowStep(
    clinic: Clinic,
    convo: Conversation,
    normalized: string,
    originalText: string,
  ): Promise<void> {
    const step = convo.flowStep as FlowStep;
    const data = ((convo.flowData as unknown) as FlowData) ?? {};

    // "cancelar" en cualquier paso de la FSM de agendamiento aborta y resetea.
    // En CONFIRM lo procesa `handleConfirm` para distinguir "no", "cancelar" y
    // "reagendar" como respuestas explícitas al resumen de la cita.
    if (
      step !== 'CONFIRM' &&
      step !== 'AWAITING_NPS_SCORE' &&
      step !== 'AWAITING_NPS_COMMENT' &&
      isFlowAbort(normalized)
    ) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Listo, dejé el agendamiento en pausa. Cuando quieras, escríbeme *agendar* para retomar.',
      );
      return;
    }

    switch (step) {
      case 'ASK_SERVICE':
        await this.handleAskService(clinic, convo, data, normalized);
        return;
      case 'ASK_PROFESSIONAL':
        await this.handleAskProfessional(clinic, convo, data, normalized);
        return;
      case 'ASK_SLOT':
        await this.handleAskSlot(clinic, convo, data, normalized);
        return;
      case 'ASK_NAME':
        await this.handleAskName(clinic, convo, data, originalText);
        return;
      case 'CONFIRM':
        await this.handleConfirm(clinic, convo, data, normalized, originalText);
        return;
      case 'AWAITING_NPS_SCORE':
        await this.handleAwaitingNpsScore(clinic, convo, data, normalized);
        return;
      case 'AWAITING_NPS_COMMENT':
        await this.handleAwaitingNpsComment(clinic, convo, data, originalText);
        return;
      default:
        // Estado desconocido: resetear y arrancar de cero.
        await this.resetFlow(convo.id);
        await this.startFlow(clinic, convo);
    }
  }

  // ─────────────────────────── FSM: pasos ───────────────────────────

  private async handleAskService(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    normalized: string,
  ): Promise<void> {
    const choice = this.resolveChoice(data.choices ?? [], normalized);
    if (!choice) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        `Creo que no te entendí. Elige un servicio de la lista:\n\n${this.choiceList(data)}\n\nResponde con el número o el nombre.`,
      );
      return;
    }
    const service = await this.prisma.service.findFirst({
      where: { id: choice.id, clinicId: clinic.id, active: true },
    });
    if (!service) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Ese servicio ya no está disponible. Escríbeme *agendar* para empezar de nuevo.',
      );
      return;
    }
    const nextData: FlowData = { serviceId: service.id };
    await this.advanceToProfessional(clinic, convo, nextData, service);
  }

  private async advanceToProfessional(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    service: Service,
  ): Promise<void> {
    const professionals = await this.prisma.professional.findMany({
      where: {
        clinicId: clinic.id,
        active: true,
        services: { some: { id: service.id } },
      },
      orderBy: { name: 'asc' },
    });

    if (professionals.length === 0) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Por ahora no tengo profesionales disponibles para ese servicio. Escríbeme más tarde.',
      );
      return;
    }

    // Solo uno → saltamos directo a ASK_SLOT sin preguntar.
    if (professionals.length === 1) {
      const only = professionals[0];
      const nextData: FlowData = { ...data, professionalId: only.id };
      await this.advanceToSlot(clinic, convo, nextData, service.id, only.id, only.name);
      return;
    }

    const choices = professionals.map((p) => ({ id: p.id, label: p.name }));
    const nextData: FlowData = { ...data, choices };
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { flowStep: 'ASK_PROFESSIONAL', flowData: nextData as object },
    });
    const list = choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      `Perfecto. ¿Con qué profesional prefieres?\n\n${list}\n\nResponde con el número o el nombre.`,
    );
  }

  private async handleAskProfessional(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    normalized: string,
  ): Promise<void> {
    if (!data.serviceId) {
      await this.resetFlow(convo.id);
      await this.startFlow(clinic, convo);
      return;
    }
    const choice = this.resolveChoice(data.choices ?? [], normalized);
    if (!choice) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        `Creo que no te entendí. Elige un profesional de la lista:\n\n${this.choiceList(data)}\n\nResponde con el número o el nombre.`,
      );
      return;
    }
    const professional = await this.prisma.professional.findFirst({
      where: {
        id: choice.id,
        clinicId: clinic.id,
        active: true,
        services: { some: { id: data.serviceId } },
      },
    });
    if (!professional) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Ese profesional ya no está disponible. Escríbeme *agendar* para retomar.',
      );
      return;
    }
    await this.advanceToSlot(
      clinic,
      convo,
      { ...data, professionalId: professional.id },
      data.serviceId,
      professional.id,
      professional.name,
    );
  }

  private async advanceToSlot(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    serviceId: string,
    professionalId: string,
    _professionalName: string,
  ): Promise<void> {
    const zone = clinic.timezone;
    const now = DateTime.now().setZone(zone);
    const slots = await this.availability.getSlots({
      clinicId: clinic.id,
      serviceId,
      professionalId,
      fromISO: now.toISO() ?? now.toString(),
      days: 7,
      limit: 6,
    });

    if (slots.length === 0) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'No encontré horarios libres en los próximos días. Escríbeme más tarde y volvemos a intentar.',
      );
      return;
    }

    const offeredSlots = slots.map((s) => s.startAt.toISOString());
    const labels = slots.map((s, i) => `${i + 1}. ${this.slotLabel(s, clinic)}`);
    const nextData: FlowData = { ...data, offeredSlots };
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { flowStep: 'ASK_SLOT', flowData: nextData as object },
    });
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      `Vamos bien. Estos son los próximos horarios disponibles:\n\n${labels.join('\n')}\n\nResponde con el número del horario que prefieras.`,
    );
  }

  private async handleAskSlot(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    normalized: string,
  ): Promise<void> {
    const offered = data.offeredSlots ?? [];
    // Parseamos SOLO por índice para slots (evitar ambigüedades de fecha en texto libre).
    // El paciente puede escribir "1", "2.", "opción 3", etc.
    const match = normalized.match(/\d+/);
    if (!match) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        `Creo que no te entendí. Elige un horario respondiendo con su número:\n\n${this.offeredSlotList(offered, clinic)}`,
      );
      return;
    }
    const idx = Number.parseInt(match[0], 10) - 1;
    if (idx < 0 || idx >= offered.length) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        `Ese número no está en la lista. Elige uno entre 1 y ${offered.length}:\n\n${this.offeredSlotList(offered, clinic)}`,
      );
      return;
    }
    const startAtISO = offered[idx];

    // Cargamos servicio y profesional para armar el mensaje de confirmación.
    const [service, professional] = await Promise.all([
      this.prisma.service.findFirst({
        where: { id: data.serviceId!, clinicId: clinic.id },
      }),
      this.prisma.professional.findFirst({
        where: { id: data.professionalId!, clinicId: clinic.id },
      }),
    ]);
    if (!service || !professional) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Algo cambió en la agenda. Escríbeme *agendar* para volver a intentar.',
      );
      return;
    }

    const nextData: FlowData = { ...data, startAtISO };

    // Si ya tenemos el nombre del paciente registrado en DB, saltamos ASK_NAME.
    // Nunca pisamos un nombre existente (respetamos la privacidad + evitamos typos).
    // Requiere `convo.phone` (Patient se identifica por phone). En conversaciones
    // que llegaron via LID (phone=null), forzamos ASK_NAME → mas abajo el flujo
    // va a pedir el numero de contacto tambien. TODO: extender FSM con ASK_PHONE
    // cuando phone no se conoce.
    const existingPatient = convo.phone
      ? await this.prisma.patient.findUnique({
          where: {
            clinicId_phone: { clinicId: clinic.id, phone: convo.phone },
          },
        })
      : null;
    if (existingPatient?.name && existingPatient.name.trim().length > 0) {
      await this.prisma.conversation.update({
        where: { id: convo.id },
        data: { flowStep: 'CONFIRM', flowData: nextData as object },
      });
      const when = this.formatWhen(startAtISO, clinic);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        `Último paso. ¿Confirmo tu cita, ${existingPatient.name}, de ${service.name} con ${professional.name} el ${when}? Responde *SÍ* para confirmar o *no* para cancelar.`,
      );
      return;
    }

    // Paciente nuevo (o sin nombre): pedimos el nombre antes de confirmar.
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { flowStep: 'ASK_NAME', flowData: nextData as object },
    });
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      'Ya casi terminamos. ¿A nombre de quién agendo la cita?',
    );
  }

  private async handleAskName(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    originalText: string,
  ): Promise<void> {
    // Sanitizar: trim, colapsar espacios y limitar a 80 chars (protección contra
    // typos gigantes o bots que peguen paredes de texto).
    const cleaned = originalText.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (cleaned.length === 0) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Creo que no te entendí. ¿A nombre de quién agendo la cita?',
      );
      return;
    }
    if (!data.serviceId || !data.professionalId || !data.startAtISO) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Perdí el hilo del agendamiento. Escríbeme *agendar* y empezamos de nuevo.',
      );
      return;
    }

    // Cargamos servicio y profesional para armar el mensaje de confirmación.
    const [service, professional] = await Promise.all([
      this.prisma.service.findFirst({
        where: { id: data.serviceId, clinicId: clinic.id },
      }),
      this.prisma.professional.findFirst({
        where: { id: data.professionalId, clinicId: clinic.id },
      }),
    ]);
    if (!service || !professional) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Algo cambió en la agenda. Escríbeme *agendar* para volver a intentar.',
      );
      return;
    }

    const nextData: FlowData = { ...data, patientName: cleaned };
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { flowStep: 'CONFIRM', flowData: nextData as object },
    });
    const when = this.formatWhen(data.startAtISO, clinic);
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      `Último paso. ¿Confirmo tu cita, ${cleaned}, de ${service.name} con ${professional.name} el ${when}? Responde *SÍ* para confirmar o *no* para cancelar.`,
    );
  }

  private async handleConfirm(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    normalized: string,
    _originalText: string,
  ): Promise<void> {
    const action = this.parseFlowConfirmReply(normalized);

    if (!action) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Solo necesito un *SÍ* para confirmar o un *no* para cancelar el agendamiento.',
      );
      return;
    }

    // "reagendar" / "reprogramar" en CONFIRM: no reseteamos, volvemos a ASK_SLOT
    // con la lista fresca de horarios preservando serviceId, professionalId y
    // patientName. Reduce fricción — el paciente cambió de opinión sobre la
    // hora, no sobre agendar.
    if (action === 'RESCHEDULE') {
      await this.reofferSlotsAfterConflict(clinic, convo, data);
      return;
    }

    if (action === 'NO' || action === 'CANCEL') {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Listo, no agendé nada. Cuando quieras retomar, escríbeme *agendar*.',
      );
      return;
    }

    if (!data.serviceId || !data.professionalId || !data.startAtISO) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Perdí el hilo del agendamiento. Escríbeme *agendar* y empezamos de nuevo.',
      );
      return;
    }

    // Sin phone (Conversation llegó por `@lid`) no podemos crear el Patient
    // por acá. En vez de rebotar al paciente, escalamos al form web: mandamos
    // un link firmado con TTL 30 min y reseteamos la FSM. Cuando el paciente
    // completa el form, `POST /public/:slug/appointments` consume el token y
    // ata la cita a esta Conversation via `conversationId` (source=BOT_WEB).
    // Ver ADR 0015.
    if (!convo.phone) {
      const link = await this.buildSchedulingLink(convo, clinic);
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        `Para terminar de agendar necesito tu número de teléfono. Completa tu cita aquí, el enlace vence en 30 minutos:\n\n${link}`,
      );
      return;
    }

    try {
      const appt = await this.scheduling.createAppointment({
        clinicId: clinic.id,
        // Solo pasamos `name` si lo recolectamos en ASK_NAME. Si el paciente ya
        // existía con nombre, no lo mandamos → el upsert respeta el valor previo.
        patient: {
          phone: convo.phone,
          ...(data.patientName ? { name: data.patientName } : {}),
        },
        serviceId: data.serviceId,
        professionalId: data.professionalId,
        startAtISO: data.startAtISO,
        source: 'BOT',
      });

      await this.resetFlow(convo.id);

      // Nombres para el cierre (Peak-End: el paciente recuerda el último
      // mensaje; debe decir QUÉ reservó y con QUIÉN). Best-effort: si algo
      // falla en la lectura, cae a genéricos y no rompe la confirmación.
      const [svc, pro] = await Promise.all([
        this.prisma.service.findFirst({
          where: { id: data.serviceId, clinicId: clinic.id },
        }),
        this.prisma.professional.findFirst({
          where: { id: data.professionalId, clinicId: clinic.id },
        }),
      ]);
      const confirmed = { service: svc, professional: pro };

      const when = this.formatWhen(data.startAtISO, clinic);
      const address = clinic.address ? `\nDirección: ${clinic.address}` : '';
      const status = appt.status === 'CONFIRMADA' ? 'confirmada' : 'agendada';
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.resolveConfirmMessage({
          status,
          when,
          clinicName: clinic.name,
          address,
          service: confirmed.service?.name ?? 'consulta',
          professional: confirmed.professional?.name ?? 'el profesional',
        }),
      );
    } catch (e) {
      if (e instanceof ConflictException) {
        // El slot se ocupó entre ASK_SLOT y CONFIRM. En vez de resetear la FSM,
        // re-listamos horarios y volvemos a ASK_SLOT — reduce fricción y evita
        // que el paciente tenga que arrancar de cero.
        await this.reofferSlotsAfterConflict(clinic, convo, data);
        return;
      }
      // Slot caducado entre ASK_SLOT y CONFIRM: SchedulingService tira
      // BadRequestException('no se pueden agendar horarios pasados'). No
      // maquillamos con el mensaje genérico "se me complicó" — le decimos al
      // paciente qué pasó y re-ofrecemos slots.
      if (
        e instanceof BadRequestException &&
        typeof (e as BadRequestException).message === 'string' &&
        (e as BadRequestException).message.toLowerCase().includes('pasado')
      ) {
        await this.reofferSlotsAfterExpired(clinic, convo, data);
        return;
      }
      this.logger.error(`Error creando cita desde el bot: ${e}`);
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Se me complicó registrar la cita. Vuelve a intentar en un momento o escribe *humano* para hablar con una persona.',
      );
    }
  }

  /**
   * Se llama cuando `SchedulingService.createAppointment` tira ConflictException
   * en CONFIRM (el slot se ocupó justo antes). Vuelve a consultar disponibilidad
   * y regresa la FSM a ASK_SLOT con la nueva lista, preservando servicio +
   * profesional + patientName (no perdemos lo que ya recolectamos). Si no queda
   * ningún horario, ahí sí resetea con mensaje amable.
   */
  private async reofferSlotsAfterConflict(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
  ): Promise<void> {
    if (!data.serviceId || !data.professionalId) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Perdí el hilo del agendamiento. Escríbeme *agendar* y empezamos de nuevo.',
      );
      return;
    }

    const zone = clinic.timezone;
    const now = DateTime.now().setZone(zone);
    const slots = await this.availability.getSlots({
      clinicId: clinic.id,
      serviceId: data.serviceId,
      professionalId: data.professionalId,
      fromISO: now.toISO() ?? now.toString(),
      days: 7,
      limit: 6,
    });

    if (slots.length === 0) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Por ahora no quedan horarios en los próximos 7 días para este servicio y profesional. Escríbeme *agendar* más tarde y probamos de nuevo.',
      );
      return;
    }

    const offeredSlots = slots.map((s) => s.startAt.toISOString());
    const labels = slots.map((s, i) => `${i + 1}. ${this.slotLabel(s, clinic)}`);
    // Preservamos serviceId, professionalId y patientName; descartamos el
    // startAtISO viejo (ese era el que se acababa de ocupar).
    const nextData: FlowData = {
      serviceId: data.serviceId,
      professionalId: data.professionalId,
      ...(data.patientName ? { patientName: data.patientName } : {}),
      offeredSlots,
    };
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { flowStep: 'ASK_SLOT', flowData: nextData as object },
    });
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      `¡Ay! Ese horario acaba de ocuparse. Te muestro los que quedan libres:\n\n${labels.join('\n')}\n\nElige uno respondiendo con el número.`,
    );
  }

  /**
   * Variante del re-ofrecimiento cuando el slot caducó (quedó en el pasado)
   * entre ASK_SLOT y CONFIRM. Misma lógica que reofferSlotsAfterConflict,
   * cambia el mensaje introductorio para reflejar la causa real y no confundir
   * al paciente.
   */
  private async reofferSlotsAfterExpired(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
  ): Promise<void> {
    if (!data.serviceId || !data.professionalId) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Perdí el hilo del agendamiento. Escríbeme *agendar* y empezamos de nuevo.',
      );
      return;
    }

    const zone = clinic.timezone;
    const now = DateTime.now().setZone(zone);
    const slots = await this.availability.getSlots({
      clinicId: clinic.id,
      serviceId: data.serviceId,
      professionalId: data.professionalId,
      fromISO: now.toISO() ?? now.toString(),
      days: 7,
      limit: 6,
    });

    if (slots.length === 0) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Por ahora no quedan horarios en los próximos 7 días para este servicio y profesional. Escríbeme *agendar* más tarde y probamos de nuevo.',
      );
      return;
    }

    const offeredSlots = slots.map((s) => s.startAt.toISOString());
    const labels = slots.map((s, i) => `${i + 1}. ${this.slotLabel(s, clinic)}`);
    const nextData: FlowData = {
      serviceId: data.serviceId,
      professionalId: data.professionalId,
      ...(data.patientName ? { patientName: data.patientName } : {}),
      offeredSlots,
    };
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { flowStep: 'ASK_SLOT', flowData: nextData as object },
    });
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      `Ese horario ya pasó. Te muestro los que quedan libres:\n\n${labels.join('\n')}\n\nElige uno respondiendo con el número.`,
    );
  }

  // ─────────────────────────── Helpers ───────────────────────────

  /**
   * Filtro de "cita abierta y futura" de un teléfono dentro de la clínica.
   * Compartido por `findUpcomingAppointment` y por el gate de confirmación
   * para que no se desincronicen si mañana cambia la lista de estados.
   */
  private static readonly upcomingAppointmentStatuses = [
    'PENDIENTE',
    'EN_RIESGO',
    'CONFIRMADA',
  ] as const;

  /**
   * ¿Tiene sentido leer un "sí" suelto como confirmación? Solo si le
   * preguntamos algo primero. Dos fuentes, en orden de costo:
   *
   *  1. El último mensaje que mandamos pide confirmar con `*SÍ*` — cubre el
   *     saludo con cita próxima (`greetingWithAppointment`) y la rama
   *     `Intent.CONFIRMAR`, que piden "responde *SÍ*" SIN crear ningún
   *     `Reminder`. Sin esto el bot castigaba la respuesta que él mismo pidió.
   *  2. Hay un `Reminder` con `status = SENT` en las últimas 48 h para una cita
   *     próxima de este teléfono en ESTA clínica — el caso del recordatorio
   *     anti no-show, que puede llegar días después del último mensaje.
   *
   * `Reminder` no tiene tenant propio: el filtro multi-tenant va sobre la cita
   * (`appointment.clinicId`) y sobre el paciente (`patient.clinicId`).
   */
  private async hasConfirmationContext(
    clinicId: string,
    conversationId: string,
    phone: string,
  ): Promise<boolean> {
    const lastOut = await this.prisma.message.findFirst({
      where: { conversationId, direction: 'OUT' },
      orderBy: { createdAt: 'desc' },
      select: { body: true },
    });
    if (lastOut && /\*s[ií]\*/i.test(lastOut.body)) return true;

    // `minus({ hours })` sobre instantes: el resultado no depende de la zona,
    // así que acá no hace falta la TZ de la clínica (a diferencia de todo lo
    // que se le muestra al paciente, que sí va en su zona).
    const now = DateTime.now();
    const reminder = await this.prisma.reminder.findFirst({
      where: {
        status: 'SENT',
        sentAt: {
          gte: now
            .minus({ hours: BotService.REMINDER_REPLY_WINDOW_H })
            .toJSDate(),
        },
        appointment: {
          clinicId,
          status: { in: [...BotService.upcomingAppointmentStatuses] },
          startAt: { gte: now.toJSDate() },
          patient: { clinicId, phone },
        },
      },
      select: { id: true },
    });
    return reminder !== null;
  }

  private parseFlowConfirmReply(normalized: string): FlowConfirmAction | null {
    if (startsWithAny(normalized, ['no'])) return 'NO';
    return parseReminderReply(normalized);
  }

  private async handleReminderReply(
    clinic: Clinic,
    convo: Conversation,
    action: ReminderReplyAction,
    phone: string | null,
  ): Promise<void> {
    if (!phone) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'No pude asociar este chat a una cita. Te derivo con recepción para ayudarte.',
      );
      await this.markNeedsHuman(convo.id);
      return;
    }

    const appt = await this.findUpcomingAppointment(clinic.id, phone);
    if (!appt) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'No encontré una cita próxima asociada a este número. Si necesitas ayuda, escribe *humano* para hablar con una persona.',
      );
      return;
    }

    if (action === 'YES') {
      await this.reminders.confirmAppointment(appt.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        '¡Listo! Tu cita quedó confirmada. Te esperamos.',
      );
      return;
    }

    if (action === 'CANCEL') {
      await this.prisma.appointment.update({
        where: { id: appt.id },
        data: { status: 'CANCELADA', canceledAt: DateTime.now().toJSDate() },
      });
      await this.reminders.cancelForAppointment(appt.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Tu cita fue cancelada. Cuando quieras, escríbeme para reagendar.',
      );
      return;
    }

    await this.reminders.cancelForAppointment(appt.id);
    await this.markNeedsHuman(convo.id);
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      'Te derivo con recepción para reagendar esa cita. No voy a moverla hasta que confirmes el nuevo horario.',
    );
  }

  private async markNeedsHuman(convoId: string): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: convoId },
      data: {
        state: 'NEEDS_HUMAN',
        flowStep: null,
        flowData: Prisma.JsonNull,
      },
    });
  }

  /**
   * Resuelve la elección del usuario: primero intenta como número (índice
   * 1-based, tolera "1.", "opción 2", etc.), después por match parcial en el
   * label (sólo si el texto normalizado tiene >= 3 chars, para evitar falsos
   * positivos con letras sueltas como "a" que matchea "Ana"). Barato y
   * determinista — sin LLM en pasos triviales.
   */
  private resolveChoice(
    choices: Array<{ id: string; label: string }>,
    normalized: string,
  ): { id: string; label: string } | null {
    if (choices.length === 0) return null;
    const numMatch = normalized.match(/\d+/);
    if (numMatch) {
      const idx = Number.parseInt(numMatch[0], 10) - 1;
      if (idx >= 0 && idx < choices.length) return choices[idx];
    }
    // Match por nombre sólo si el texto tiene mínimo 3 chars — un "a" solo no
    // debe resolver a "Ana" ni "1." debe caer a algo raro.
    if (normalized.length < 3) return null;
    const byName = choices.find((c) =>
      c.label.toLowerCase().includes(normalized),
    );
    return byName ?? null;
  }

  private slotLabel(slot: Slot, clinic: Clinic): string {
    return DateTime.fromJSDate(slot.startAt)
      .setZone(clinic.timezone)
      .setLocale(clinic.locale)
      .toFormat("cccc d 'de' LLLL, HH:mm");
  }

  /** Lista numerada de `data.choices` para repetir opciones en errores. */
  private choiceList(data: FlowData): string {
    return (data.choices ?? [])
      .map((c, i) => `${i + 1}. ${c.label}`)
      .join('\n');
  }

  /** Lista numerada de los slots ofrecidos (ISO) formateados en TZ clínica. */
  private offeredSlotList(offered: string[], clinic: Clinic): string {
    return offered
      .map((iso, i) => `${i + 1}. ${this.formatWhen(iso, clinic)}`)
      .join('\n');
  }

  private formatWhen(iso: string, clinic: Clinic): string {
    return DateTime.fromISO(iso, { zone: clinic.timezone })
      .setLocale(clinic.locale)
      .toFormat("cccc d 'de' LLLL 'a las' HH:mm");
  }

  // ─────────────────────────── Sub-FSM: feedback ───────────────────────────

  // AWAITING_NPS_SCORE: paciente responde el prompt de satisfacción con un
  // número 1-5. Aceptamos también el número escrito ("cinco") sólo para 1-5.
  // Fuera de rango o texto que no matchea: le pedimos que corrija (no
  // reseteamos la sub-FSM porque podría estar tipeando distinto).
  private async handleAwaitingNpsScore(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    normalized: string,
  ): Promise<void> {
    const apptId = data.feedbackAppointmentId;
    if (!apptId) {
      // Estado corrupto: caemos gracefully al reset.
      await this.resetFlow(convo.id);
      return;
    }

    const score = this.parseNpsScore(normalized);
    if (score === null) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Creo que no te entendí. Respóndeme con un número del *1* al *5*.',
      );
      return;
    }

    const { created } = await this.followUps.recordFeedback(
      clinic.id,
      apptId,
      score,
    );

    if (!created) {
      // Ya había respondido antes. Le agradecemos igual y cerramos sub-FSM.
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        '¡Gracias por tu respuesta!',
      );
      return;
    }

    // Guardamos el score en flowData y pasamos a esperar comentario opcional.
    const nextData: FlowData = { ...data, feedbackScore: score };
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: {
        flowStep: 'AWAITING_NPS_COMMENT',
        flowData: nextData as object,
      },
    });

    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      '¡Gracias! Si quieres contarnos algo más, escríbelo ahora ' +
        '(o responde *no* para finalizar).',
    );
  }

  // AWAITING_NPS_COMMENT: 2do paso opcional. El paciente puede mandar un
  // texto libre que se guarda como `Feedback.comment`, o "no"/"nada"/"listo"
  // para cerrar sin comentario. En ambos casos reseteamos la sub-FSM.
  private async handleAwaitingNpsComment(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    originalText: string,
  ): Promise<void> {
    const apptId = data.feedbackAppointmentId;
    const skip = ['no', 'nada', 'listo', 'ok'].includes(
      originalText.trim().toLowerCase(),
    );

    if (apptId && !skip) {
      // Actualizamos el comment del feedback existente (la row se creó en el
      // paso previo). NO usamos followUps.recordFeedback porque ya existe.
      await this.prisma.feedback.update({
        where: { appointmentId: apptId },
        data: { comment: originalText.trim().slice(0, 1000) },
      });
    }

    await this.resetFlow(convo.id);
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      '¡Muchas gracias por tu tiempo! Que tengas un buen día.',
    );
  }

  // Parsea "5", "cinco", " 3 " → 1-5 | null si no es válido.
  // Solo aceptamos escrito para dígitos 1-5 (rango de nuestro NPS/CSAT).
  private parseNpsScore(input: string): number | null {
    const t = input.trim().toLowerCase();
    const digit = Number.parseInt(t, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 5) return digit;
    const map: Record<string, number> = {
      uno: 1,
      dos: 2,
      tres: 3,
      cuatro: 4,
      cinco: 5,
    };
    if (t in map) return map[t];
    return null;
  }

  private async resetFlow(convoId: string): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: convoId },
      data: { flowStep: null, flowData: Prisma.JsonNull },
    });
  }

  private async findUpcomingAppointment(clinicId: string, phone: string) {
    const patient = await this.prisma.patient.findUnique({
      where: { clinicId_phone: { clinicId, phone } },
    });
    if (!patient) return null;
    return this.prisma.appointment.findFirst({
      where: {
        clinicId,
        patientId: patient.id,
        status: { in: [...BotService.upcomingAppointmentStatuses] },
        startAt: { gte: DateTime.now().toJSDate() },
      },
      orderBy: { startAt: 'asc' },
      include: { service: true, patient: true },
    });
  }

  /**
   * Envía la respuesta del bot al paciente. Antes del `sendText`:
   *  1) Muestra "escribiendo…" (WAHA presence).
   *  2) Duerme `typingDelayFor(text)` ms — sensación de tipeo humano.
   *  3) Detiene "escribiendo…" justo antes de mandar el texto.
   *
   * Todos los pasos de typing son best-effort: fallan silenciosos (el
   * `WahaService.startTyping/stopTyping` ya loguea a warn y no lanza).
   * El `sendText` final sí puede tirar — es lo único crítico.
   *
   * Opt-out con `BOT_TYPING_ENABLED=false`: útil en tests (evita segundos
   * de sleep por cada assert de bot) y en dev cuando querés iterar rápido.
   *
   * Después del `sendText` persistimos el `Message` con dirección OUT
   * (siempre; incluso si el typing falló) para no perder trazabilidad.
   */
  private async reply(
    session: string,
    chatId: string,
    convoId: string,
    text: string,
  ) {
    if (process.env.BOT_TYPING_ENABLED !== 'false') {
      await this.waha.startTyping(session, chatId);
      await BotService.sleep(this.typingDelayFor(text));
      await this.waha.stopTyping(session, chatId);
    }
    await this.waha.sendText(session, chatId, text);
    await this.prisma.message.create({
      data: { conversationId: convoId, direction: 'OUT', body: text },
    });
  }

  /**
   * Delay antes de mandar el mensaje, en ms. Modela una velocidad de
   * tipeo humana promedio (~40 chars/seg ≈ 30 wpm). Cap superior 4s
   * para no dejar al paciente esperando en respuestas largas del LLM;
   * mínimo 700 ms para no responder instantáneo ni siquiera al "hola".
   * Jitter ±20% para que el mismo texto no dé siempre la misma latencia
   * (los detectores buscan patrones repetidos incluso en timings).
   */
  private typingDelayFor(text: string): number {
    const base = Math.min(4000, Math.max(700, text.length * 25));
    const jitter = 1 + (Math.random() * 0.4 - 0.2);
    return Math.round(base * jitter);
  }

  /** Sleep utilitario. Static para poder ser mockeado si algún test lo pide. */
  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
