import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Clinic, Conversation, Service } from '@prisma/client';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { DateTime } from 'luxon';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../public/rate-limit.guard';
import { RemindersService } from '../reminders/reminders.service';
import { AvailabilityService, Slot } from '../scheduling/availability.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { WahaService } from '../whatsapp/waha.service';
import { Intent, IntentService } from './intent.service';

/** Pasos de la FSM de agendamiento, persistidos en Conversation.flowStep. */
type FlowStep =
  | 'ASK_SERVICE'
  | 'ASK_PROFESSIONAL'
  | 'ASK_SLOT'
  | 'ASK_NAME'
  | 'CONFIRM';

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
}

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

  /** Rate-limit por conversación (chatId): cap por minuto — ver ADR 0007. */
  private static readonly PER_CHAT_LIMIT = 15;
  /** Circuit breaker global por clínica: cap por hora — ver ADR 0007. */
  private static readonly PER_CLINIC_HOURLY_LIMIT = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly waha: WahaService,
    private readonly reminders: RemindersService,
    private readonly intent: IntentService,
    private readonly availability: AvailabilityService,
    private readonly scheduling: SchedulingService,
    private readonly knowledge: KnowledgeService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Hash corto del `chatId` para poder loguear sin filtrar PII (el chatId
   * incluye el número E.164 del paciente). 8 hex chars ≈ 32 bits, suficiente
   * para correlacionar eventos de la misma conversación en logs sin exponer
   * el identificador real.
   */
  private hashChatId(chatId: string): string {
    return createHash('sha256').update(chatId).digest('hex').slice(0, 8);
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
   * Mensajes default cuando `clinic.bot*` es NULL. Se elige el fallback
   * hardcodeado para no romper clínicas existentes que aún no tocaron
   * `/panel/ajustes`. Personalizable por tenant vía `/api/clinics/me`.
   * Placeholders soportados: `{clinicName}`, `{patientName}`.
   */
  private static readonly DEFAULT_BOT_MESSAGES = {
    greeting:
      '¡Hola! Soy el asistente de {clinicName}. Puedo ayudarte a *agendar*, *reagendar* o *cancelar* una cita, o responder dudas. ¿Qué necesitás?',
    fallback:
      'Puedo ayudarte a *agendar*, *reagendar* o *cancelar* una cita, o responder dudas. ¿Qué necesitás?',
    handoff: 'Enseguida te atiende una persona del equipo. 🙏',
  } as const;

  /** Regex para detectar saludos → dispara `greeting` en vez de fallback. */
  private static readonly GREETING_REGEX =
    /^(hola|holis|holaa+|buenas|buenos d[ií]as|buenas tardes|buenas noches|hey|hi|hello)\b/i;

  /**
   * Resuelve el mensaje del bot para una clínica, aplicando el custom si existe
   * o el default. Reemplaza placeholders `{clinicName}` y `{patientName}`.
   */
  private resolveBotMessage(
    clinic: Pick<
      Clinic,
      'name' | 'botGreeting' | 'botFallback' | 'botHandoffMsg'
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
      customMap[key] || BotService.DEFAULT_BOT_MESSAGES[key];
    return template
      .replace(/\{clinicName\}/g, clinic.name)
      .replace(/\{patientName\}/g, ctx?.patientName ?? '');
  }

  async handleIncoming(input: {
    clinicId: string;
    chatId: string;
    /** E.164 sin sufijo, o null si `chatId` es un @lid (no conocemos el phone). */
    phone: string | null;
    /** LID de WhatsApp sin sufijo, si el chatId venia como @lid. */
    lid?: string | null;
    /** pushName visible del contacto (puede cambiar entre mensajes). */
    contactName?: string | null;
    text: string;
  }): Promise<void> {
    const { clinicId, chatId, phone, lid, contactName, text } = input;

    // ── Rate-limit por conversación + circuit breaker global (ADR 0007) ──
    // Fixed-window por minuto en `(clinicId, chatId)`. Silencio total al superar:
    // no respondemos al spammer (evita amplificar el ataque quemando LLM budget).
    // Fail-open si Redis está caído (loggeamos error) — la protección real la
    // dan los constraints DB y el resto de rate-limits.
    try {
      const now = Date.now();
      const rlKey = `bot:msg:${clinicId}:${chatId}:${Math.floor(now / 60000)}`;
      const count = await this.redis.incr(rlKey);
      if (count === 1) await this.redis.expire(rlKey, 90);
      if (count > BotService.PER_CHAT_LIMIT) {
        this.logger.warn(
          `bot rate-limit clinic=${clinicId} chat=${this.hashChatId(chatId)} count=${count}`,
        );
        return;
      }

      // Circuit breaker por clínica/hora — cap costo LLM ante ataque distribuido.
      const chKey = `bot:msg:${clinicId}:hour:${Math.floor(now / 3600000)}`;
      const hourCount = await this.redis.incr(chKey);
      if (hourCount === 1) await this.redis.expire(chKey, 3900);
      if (hourCount > BotService.PER_CLINIC_HOURLY_LIMIT) {
        this.logger.error(
          `bot hourly cap clinic=${clinicId} count=${hourCount} — circuit OPEN`,
        );
        return;
      }
    } catch (e) {
      this.logger.error(
        `bot rate-limit falló (redis) clinic=${clinicId}: ${(e as Error).message}`,
      );
      // fail-open: seguimos procesando.
    }

    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
    });

    // Upsert de la conversación. En update solo tocamos `contactName` si vino
    // uno nuevo (WhatsApp permite cambiarlo) — evita clobbears innecesarios.
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
      update: contactName ? { contactName } : {},
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

    const normalized = text.trim().toLowerCase();

    // "cancelar" en cualquier momento aborta la FSM y resetea (regla del SPEC).
    // Excepción: si NO hay FSM activa, "cancelar" cae al flujo de cancelar cita.
    if (
      convo.flowStep &&
      ['cancelar', 'cancela', 'abortar', 'salir'].includes(normalized)
    ) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        chatId,
        convo.id,
        'Listo, dejé el agendamiento en pausa. Cuando quieras, escribime "agendar" para retomar.',
      );
      return;
    }

    // Escape universal a humano: desde CUALQUIER paso (con o sin FSM) el paciente
    // puede pedir hablar con una persona y salimos del bot inmediatamente.
    // Palabras: humano, persona, operador, asesor, representante, attendant, o
    // la frase "hablar con". Reseteamos FSM y marcamos NEEDS_HUMAN para la bandeja.
    if (this.isHumanEscape(normalized)) {
      await this.prisma.conversation.update({
        where: { id: convo.id },
        data: {
          state: 'NEEDS_HUMAN',
          flowStep: null,
          flowData: undefined,
        },
      });
      await this.reply(
        clinic.wahaSession,
        chatId,
        convo.id,
        this.resolveBotMessage(clinic, 'handoff'),
      );
      return;
    }

    // 0.5) Saludo — antes de meterse con confirmaciones/intent. Responde
    // el `botGreeting` (o default). Cortés y barato: no gasta LLM.
    if (BotService.GREETING_REGEX.test(normalized)) {
      await this.reply(
        clinic.wahaSession,
        chatId,
        convo.id,
        this.resolveBotMessage(clinic, 'greeting'),
      );
      return;
    }

    // 1) FSM activa: procesamos el paso ANTES de tocar el LLM.
    if (convo.flowStep) {
      await this.handleFlowStep(clinic, convo, normalized, text);
      return;
    }

    // 2) Confirmaciones deterministas (recordatorios) — solo si NO hay FSM.
    // Requiere phone conocido (buscamos Patient por phone). Si el contacto
    // llegó con LID (phone=null) no podemos correlacionar → skip.
    if (
      phone &&
      ['sí', 'si', 'confirmo', 'confirmar', 'ok', 'dale'].includes(normalized)
    ) {
      const appt = await this.findUpcomingAppointment(clinicId, phone);
      if (appt) {
        await this.reminders.confirmAppointment(appt.id);
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          '¡Listo! Tu cita quedó confirmada. Te esperamos.',
        );
        return;
      }
    }
    if (phone && ['cancelar', 'cancela'].includes(normalized)) {
      const appt = await this.findUpcomingAppointment(clinicId, phone);
      if (appt) {
        await this.prisma.appointment.update({
          where: { id: appt.id },
          data: { status: 'CANCELADA', canceledAt: DateTime.now().toJSDate() },
        });
        await this.reminders.cancelForAppointment(appt.id);
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          'Tu cita fue cancelada. Cuando quieras, escribime para reagendar.',
        );
        return;
      }
    }

    // 3) Detección de intención con LLM.
    const intent = await this.intent.detect(text, clinic.locale);
    switch (intent) {
      case Intent.HABLAR_HUMANO:
        await this.prisma.conversation.update({
          where: { id: convo.id },
          data: { state: 'NEEDS_HUMAN' },
        });
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          this.resolveBotMessage(clinic, 'handoff'),
        );
        break;

      case Intent.AGENDAR:
      case Intent.REPROGRAMAR:
        await this.startFlow(clinic, convo);
        break;

      case Intent.PREGUNTA_FAQ: {
        // RAG sobre FaqChunk: si hay match confiable → respondemos con el
        // texto sintetizado por el LLM desde las fuentes. Si no → handoff a
        // humano (política "prefiero handoff que alucinar").
        const result = await this.knowledge.answer({
          clinicId,
          question: text,
          locale: clinic.locale,
          tone: clinic.botTone, // custom per-tenant desde /panel/ajustes
        });
        if (result) {
          await this.reply(
            clinic.wahaSession,
            chatId,
            convo.id,
            result.answer,
          );
        } else {
          await this.prisma.conversation.update({
            where: { id: convo.id },
            data: { state: 'NEEDS_HUMAN' },
          });
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
        'Por ahora no tenemos servicios cargados. Escribime más tarde o pedí hablar con una persona.',
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
      `¡Con gusto te agendo! ¿Qué servicio necesitás?\n\n${list}\n\nResponde con el número o el nombre.`,
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
        'No entendí, respondeme con el número o el nombre del servicio.',
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
        'Ese servicio ya no está disponible. Escribime "agendar" para arrancar de nuevo.',
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
        'Por ahora no tengo profesionales disponibles para ese servicio. Escribime más tarde.',
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
      `Perfecto. ¿Con qué profesional preferís?\n\n${list}\n\nResponde con el número o el nombre.`,
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
        'No entendí, respondeme con el número o el nombre del profesional.',
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
        'Ese profesional ya no está disponible. Escribime "agendar" para retomar.',
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
        'No encontré horarios libres en los próximos días. Escribime más tarde y volvemos a intentar.',
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
      `Estos son los próximos horarios disponibles:\n\n${labels.join('\n')}\n\nResponde con el número del horario que prefieras.`,
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
        'Respondeme con el número del horario, por favor.',
      );
      return;
    }
    const idx = Number.parseInt(match[0], 10) - 1;
    if (idx < 0 || idx >= offered.length) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        `Ese número no está en la lista. Elegí uno entre 1 y ${offered.length}.`,
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
        'Algo cambió en la agenda. Escribime "agendar" para volver a intentar.',
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
        `¿Confirmo tu cita, ${existingPatient.name}, de ${service.name} con ${professional.name} el ${when}? Responde *SÍ* para confirmar o *no* para cancelar.`,
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
      '¿A nombre de quién agendo la cita?',
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
        'Necesito un nombre válido. ¿A nombre de quién agendo la cita?',
      );
      return;
    }
    if (!data.serviceId || !data.professionalId || !data.startAtISO) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Perdí el hilo del agendamiento. Escribime "agendar" y arrancamos de nuevo.',
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
        'Algo cambió en la agenda. Escribime "agendar" para volver a intentar.',
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
      `¿Confirmo tu cita, ${cleaned}, de ${service.name} con ${professional.name} el ${when}? Responde *SÍ* para confirmar o *no* para cancelar.`,
    );
  }

  private async handleConfirm(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    normalized: string,
    _originalText: string,
  ): Promise<void> {
    const yes = ['sí', 'si', 'confirmo', 'confirmar', 'ok', 'dale'].includes(normalized);
    const no = ['no', 'cancelar'].includes(normalized);
    const reschedule = ['reagendar', 'reprogramar'].includes(normalized);

    if (!yes && !no && !reschedule) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Respondeme *SÍ* para confirmar o *no* para cancelar el agendamiento.',
      );
      return;
    }

    // "reagendar" / "reprogramar" en CONFIRM: no reseteamos, volvemos a ASK_SLOT
    // con la lista fresca de horarios preservando serviceId, professionalId y
    // patientName. Reduce fricción — el paciente cambió de opinión sobre la
    // hora, no sobre agendar.
    if (reschedule) {
      await this.reofferSlotsAfterConflict(clinic, convo, data);
      return;
    }

    if (no) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Listo, no agendé nada. Cuando quieras retomar, escribime "agendar".',
      );
      return;
    }

    if (!data.serviceId || !data.professionalId || !data.startAtISO) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Perdí el hilo del agendamiento. Escribime "agendar" y arrancamos de nuevo.',
      );
      return;
    }

    // Sin phone conocido no podemos crear el Patient. TODO: agregar ASK_PHONE
    // al FSM para conversaciones que llegaron con LID.
    if (!convo.phone) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        'Para confirmar tu cita necesito tu número de teléfono. Por favor escribíme al número directo de la clínica desde tu contacto.',
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

      const when = this.formatWhen(data.startAtISO, clinic);
      const address = clinic.address ? `\nDirección: ${clinic.address}` : '';
      const status = appt.status === 'CONFIRMADA' ? 'confirmada' : 'agendada';
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        `¡Listo! Tu cita quedó ${status} para el ${when} en ${clinic.name}.${address}\n\nSi necesitás cambiarla, escribime *reagendar* o *cancelar*.`,
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
        'Se me complicó registrar la cita. Volvé a intentar en un momento o pedime hablar con una persona.',
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
        'Perdí el hilo del agendamiento. Escribime "agendar" y arrancamos de nuevo.',
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
        'Por ahora no quedan horarios en los próximos 7 días para este servicio y profesional. Escribí *agendar* más tarde y probamos de nuevo.',
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
      `¡Ay! Ese horario acaba de ocuparse. Te muestro los que quedan libres:\n\n${labels.join('\n')}\n\nElegí uno respondiendo con el número.`,
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
        'Perdí el hilo del agendamiento. Escribime "agendar" y arrancamos de nuevo.',
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
        'Por ahora no quedan horarios en los próximos 7 días para este servicio y profesional. Escribí *agendar* más tarde y probamos de nuevo.',
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
      `Ese horario ya pasó. Te muestro los que quedan libres:\n\n${labels.join('\n')}\n\nElegí uno respondiendo con el número.`,
    );
  }

  // ─────────────────────────── Helpers ───────────────────────────

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

  /**
   * Detecta si el paciente pide hablar con una persona en cualquier paso del
   * flujo. Palabras sueltas: humano, persona, operador, asesor, representante,
   * attendant. Frase parcial: "hablar con".
   */
  private isHumanEscape(normalized: string): boolean {
    if (!normalized) return false;
    if (normalized.includes('hablar con')) return true;
    const tokens = normalized.split(/\s+/);
    const keywords = new Set([
      'humano',
      'persona',
      'operador',
      'asesor',
      'representante',
      'attendant',
    ]);
    return tokens.some((t) => keywords.has(t));
  }

  private slotLabel(slot: Slot, clinic: Clinic): string {
    return DateTime.fromJSDate(slot.startAt)
      .setZone(clinic.timezone)
      .setLocale(clinic.locale)
      .toFormat("cccc d 'de' LLLL, HH:mm");
  }

  private formatWhen(iso: string, clinic: Clinic): string {
    return DateTime.fromISO(iso, { zone: clinic.timezone })
      .setLocale(clinic.locale)
      .toFormat("cccc d 'de' LLLL 'a las' HH:mm");
  }

  private async resetFlow(convoId: string): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: convoId },
      data: { flowStep: null, flowData: undefined },
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
        status: { in: ['PENDIENTE', 'EN_RIESGO', 'CONFIRMADA'] },
        startAt: { gte: DateTime.now().toJSDate() },
      },
      orderBy: { startAt: 'asc' },
    });
  }

  private async reply(
    session: string,
    chatId: string,
    convoId: string,
    text: string,
  ) {
    await this.waha.sendText(session, chatId, text);
    await this.prisma.message.create({
      data: { conversationId: convoId, direction: 'OUT', body: text },
    });
  }
}
