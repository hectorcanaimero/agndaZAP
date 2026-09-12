import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Clinic, Conversation, Prisma, Service } from '@prisma/client';
import { RescheduleLimitExceededException } from '../scheduling/scheduling.errors';
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
import {
  schedulingUrl,
  schedulingUrlWithToken,
} from '../common/web-url.util';
import {
  formatSchedule,
  isWithinBusinessHours,
} from '../common/business-hours.util';
import {
  HANDOFF_TIMEOUT_HOURS,
  HandoffQueue,
  HANDOFF_QUEUE_TOKEN,
} from '../conversations/handoff.queue';
import { botCopy, BotCopy } from './bot.messages';
import { Intent, IntentService } from './intent.service';
import {
  asksForSomethingElse,
  isNoPreferenceChoice,
  parseSlotPreference,
  SlotPreference,
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
  // ── M4: navegación de horarios ──
  /** Cuántas ventanas de 7 días avanzó el paciente con "ver más horarios". */
  slotWindowCount?: number;
  /** Modo "cualquier profesional": el profesional sale del slot elegido. */
  anyProfessional?: boolean;
  /**
   * `professionalId` de cada slot ofrecido, en paralelo a `offeredSlots`. Solo
   * se llena en modo "cualquier profesional", donde cada horario puede ser de
   * uno distinto.
   */
  offeredProfessionalIds?: string[];
  /** Respuestas seguidas que no pudimos interpretar en el paso actual. */
  invalidCount?: number;
  /**
   * Id de la cita que se está MOVIENDO (B5). Con esto puesto, `CONFIRM` no
   * crea una cita nueva: llama a `rescheduleAppointment`, que la mueve in-place
   * conservando el id. Crear+cancelar inflaba `CANCELADA` y diluía el no-show
   * rate — ver la tabla de M2 en el plan del P1.
   */
  rescheduleOf?: string;
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
    @Inject(HANDOFF_QUEUE_TOKEN) private readonly handoffQueue: HandoffQueue,
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
    return schedulingUrlWithToken(clinic.locale, clinic.slug, token);
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
  /**
   * Aviso de asistente automático (ADR 0004 §7). Se agrega SIEMPRE al final
   * del greeting — también cuando la clínica personaliza `botGreeting` —
   * porque es un requisito de compliance (LGPD/GDPR), no un texto editable.
   * Es corto a propósito: la lista de proveedores de IA vive en el texto de
   * consentimiento del form público y en la política de privacidad, no en el
   * saludo. Incluye el escape a humano para que el paciente sepa salir del bot.
   */
  static readonly AI_DISCLOSURE = botCopy('es').aiDisclosure;

  /** Horas entre avisos mientras la conversación espera a una persona (S29). */
  private static readonly WAITING_NOTICE_TTL_SEC = 4 * 60 * 60;

  /** Ventana en la que un "sí" suelto se lee como respuesta a un recordatorio. */
  private static readonly REMINDER_REPLY_WINDOW_H = 48;

  /**
   * Ventana del guard de confirmación por voz (M10). Media hora: lo bastante
   * para cubrir un ida y vuelta real —el paciente escucha, escribe, se
   * equivoca— sin que una nota de voz de la semana pasada cuente como intento.
   */
  private static readonly VOICE_CONFIRM_TTL_SEC = 30 * 60;

  /** Tope de lo que se le repite al paciente de su propia nota de voz. */
  private static readonly ECHO_MAX_CHARS = 160;

  /** Días que abarca cada página de horarios en ASK_SLOT. */
  private static readonly SLOT_WINDOW_DAYS = 7;

  /**
   * Tope de "ver más horarios". Cuatro ventanas ≈ un mes: más que eso y la
   * conversación por WhatsApp deja de tener sentido frente al form web, que
   * muestra un calendario.
   */
  private static readonly MAX_SLOT_WINDOWS = 4;

  /**
   * Respuestas seguidas sin entender tras las que ofrecemos el form web. No
   * reseteamos la FSM: el paciente puede seguir por chat si quiere.
   */
  private static readonly MAX_INVALID_RETRIES = 2;

  /** `id` sintético de la opción "Cualquier profesional" en ASK_PROFESSIONAL. */
  private static readonly ANY_PROFESSIONAL = '__any__';

  /**
   * Tope de veces que el paciente puede mover su cita. Mismo número que en el
   * borde público (`PublicController.MAX_PATIENT_RESCHEDULES`): el canal no
   * debería cambiar cuántas veces puede moverla.
   */
  private static readonly MAX_PATIENT_RESCHEDULES = 3;

  /**
   * Elige una variante al azar de un array. `Math.random` es suficiente:
   * el objetivo es "no siempre el mismo string", no criptografía. Un
   * PRNG sesgado no tiene impacto de seguridad acá.
   */
  private pickVariant<T>(variants: readonly T[]): T {
    return variants[Math.floor(Math.random() * variants.length)]!;
  }

  /** Copy del bot en el idioma de la clínica (B7). */
  private copy(clinic: Pick<Clinic, 'locale'>): BotCopy {
    return botCopy(clinic.locale);
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
    const copy = botCopy(clinic.locale);
    const customMap = {
      greeting: clinic.botGreeting,
      fallback: clinic.botFallback,
      handoff: clinic.botHandoffMsg,
    } as const;
    // El override del tenant gana sobre el idioma: si la clínica escribió su
    // propio saludo, ese es el que quiere, en el idioma que lo haya escrito.
    const template = customMap[key] || this.pickVariant(copy.pools[key]);
    const rendered = template
      .replace(/\{clinicName\}/g, clinic.name)
      .replace(/\{patientName\}/g, ctx?.patientName ?? '')
      .replace(/\{link\}/g, this.publicSchedulingUrl(clinic));
    return key === 'greeting'
      ? `${rendered}\n\n${copy.aiDisclosure}`
      : rendered;
  }

  /** Tope del bloque de contexto que viaja al LLM. */
  private static readonly CONTEXT_MAX_CHARS = 600;

  /** Pares IN/OUT que se miran hacia atrás para armar el contexto. */
  private static readonly CONTEXT_PAIRS = 3;

  /**
   * Historial reciente de la conversación para que el LLM resuelva referencias
   * (M5): "¿y los sábados?" después de preguntar por horarios no significa nada
   * suelto, y hoy cada mensaje se clasifica aislado.
   *
   * Los últimos `CONTEXT_PAIRS` pares IN/OUT, del más viejo al más nuevo, con
   * tope de caracteres. Al recortar se descartan los mensajes MÁS ANTIGUOS: lo
   * último que se dijo es lo que da sentido a la pregunta actual.
   *
   * Sin PII nueva: son mensajes que ya viven en `Message`, de esta misma
   * conversación. No se cruza nada de otras.
   */
  private async buildConversationContext(
    conversationId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: BotService.CONTEXT_PAIRS * 2,
      select: { direction: true, body: true },
    });
    if (rows.length === 0) return [];

    const lines = rows
      .reverse()
      .map(
        (m) =>
          `${m.direction === 'IN' ? 'Paciente' : 'Asistente'}: ${m.body.replace(/\s+/g, ' ').trim()}`,
      )
      .filter((l) => l.length > 10);
    if (lines.length === 0) return [];

    // Recorte por el principio, quedándonos con lo más reciente.
    const kept: string[] = [];
    let total = 0;
    for (const line of [...lines].reverse()) {
      if (total + line.length + 1 > BotService.CONTEXT_MAX_CHARS) break;
      kept.unshift(line);
      total += line.length + 1;
    }
    return kept;
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
    const upcoming = await this.findUpcomingAppointment(clinic.id, convo);
    if (upcoming) return answer;

    const link = this.publicSchedulingUrl(clinic);
    const lastOut = await this.prisma.message.findFirst({
      where: { conversationId: convo.id, direction: 'OUT' },
      orderBy: { createdAt: 'desc' },
      select: { body: true },
    });
    if (lastOut?.body.includes(link)) return answer;

    const cta = this.pickVariant(this.copy(clinic).pools.ctaAfterAnswer).replace(
      /\{link\}/g,
      link,
    );
    return `${answer}\n\n${cta}`;
  }

  /**
   * URL pública de agendamiento SIN token (`/{locale}/agendar/{slug}`). Se
   * usa en el saludo: no crea SchedulingSession (cada "hola" no debe escribir
   * en DB). El link tokenizado con prefill sigue en `buildSchedulingLink`.
   */
  private publicSchedulingUrl(clinic: Pick<Clinic, 'slug' | 'locale'>): string {
    return schedulingUrl(clinic.locale, clinic.slug);
  }

  /**
   * Throttle del aviso de espera: `SET NX` por conversación con TTL de 4 h.
   * `true` = te toca avisar.
   *
   * Fail-CLOSED a propósito, igual que el aviso de adjuntos del webhook: si
   * Redis no está, el coste de no avisar es un mensaje menos —el paciente ya
   * sabe que está esperando—, y el de avisar es repetirle lo mismo en cada
   * mensaje. El entrante queda registrado en la bandeja de todas formas.
   */
  private async claimWaitingNotice(
    clinicId: string,
    chatId: string,
  ): Promise<boolean> {
    try {
      const result = await this.redis.set(
        `bot:waiting-notice:${clinicId}:${chatId}`,
        '1',
        'EX',
        BotService.WAITING_NOTICE_TTL_SEC,
        'NX',
      );
      return result !== null;
    } catch (e) {
      this.logger.warn(
        `throttle del aviso de espera falló (redis) clinic=${clinicId}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Link de gestión de una cita concreta (ADR 0020): ver, cambiar horario o
   * cancelar desde la web. Emite un token nuevo por llamada.
   *
   * Devuelve `null` si no se pudo emitir (Redis caído): el bot sigue
   * respondiendo por chat, que es lo que importa. Perder el link no puede
   * costarle al paciente la gestión de su cita.
   */
  private async manageLink(
    clinic: Pick<Clinic, 'id' | 'slug' | 'locale'>,
    appt: { id: string; clinicId: string; startAt: Date },
  ): Promise<string | null> {
    try {
      return await this.schedulingSessions.issueManageUrl(
        appt,
        clinic.slug,
        clinic.locale,
      );
    } catch (e) {
      this.logger.warn(
        `no se pudo emitir el link de gestión clinicId=${clinic.id}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Saludo con contexto: el número ya tiene una cita próxima. Ofrece las
   * acciones sobre esa cita (confirmar / reagendar / cancelar) en vez del
   * menú genérico. Devuelve null si no hay cita (→ saludo normal).
   */
  private async greetingWithAppointment(
    clinic: Clinic,
    convo: Conversation,
  ): Promise<string | null> {
    const appt = await this.findUpcomingAppointment(clinic.id, convo);
    if (!appt) return null;
    const copy = this.copy(clinic);
    const when = this.formatWhen(appt.startAt.toISOString(), clinic);
    const service = appt.service?.name ?? 'consulta';
    const statusLine =
      appt.status === 'CONFIRMADA'
        ? copy.apptConfirmedLine(service, when)
        : copy.apptPendingLine(service, when);
    const patientName = appt.patient?.name ? ` ${appt.patient.name}` : '';
    const rendered = this.pickVariant(copy.pools.greetingWithAppointment)
      .replace(/\{patientName\}/g, patientName)
      .replace(/\{statusLine\}/g, statusLine);
    return `${rendered}\n\n${copy.aiDisclosure}`;
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
    copy: BotCopy;
    status: string;
    when: string;
    clinicName: string;
    address: string;
    service: string;
    professional: string;
    /** Link de gestión (ADR 0020). Sin él caemos al "escríbeme *reagendar*". */
    manageUrl?: string | null;
  }): string {
    const template = this.pickVariant(input.copy.pools.confirmAppointment);
    const manageLine = input.manageUrl
      ? input.copy.manageLine(input.manageUrl)
      : input.copy.manageLineFallback;
    return template
      .replace(/\{status\}/g, input.status)
      .replace(/\{when\}/g, input.when)
      .replace(/\{clinicName\}/g, input.clinicName)
      .replace(/\{address\}/g, input.address)
      .replace(/\{service\}/g, input.service)
      .replace(/\{professional\}/g, input.professional)
      .replace(/\{manageLine\}/g, manageLine);
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
    /**
     * Cómo llegó el mensaje. `'audio'` significa que `text` es la
     * transcripción de una nota de voz (M10), no algo que el paciente haya
     * escrito y releído.
     *
     * **Parámetro explícito y no el contexto del turno** (`recordBotTurn`), que
     * también lo lleva: ese contexto es de observabilidad y es un no-op fuera
     * de un turno, así que un guard de seguridad colgado de él se apagaría en
     * silencio en cualquier camino que no lo abra. Aquí la ausencia tiene que
     * significar "texto escrito", y eso es lo que significa el default.
     */
    inputKind?: 'text' | 'audio';
  }): Promise<void> {
    const { clinicId, chatId, phone, lid, contactName, text } = input;
    const fromAudio = input.inputKind === 'audio';

    // NO hay rate-limit acá a propósito. Las dos capas del ADR 0007 viven en
    // `webhook.controller.ts`, ANTES de encolar en `bot-inbound` (ver
    // `docs/adr/0021-cola-bot-inbound.md`). Con la cola en medio, tenerlo
    // también aquí rompía dos cosas:
    //
    //  - cada mensaje consumía presupuesto dos veces (webhook + worker), así
    //    que los topes efectivos quedaban a la mitad;
    //  - un reintento de BullMQ volvía a consumir y, si cruzaba el cap, este
    //    método hacía `return` en silencio: el job se marcaba completado y el
    //    mensaje del paciente se perdía sin fallo, sin Sentry y sin quedar en
    //    la bandeja.
    //
    // Si vienes del ADR 0007 buscando por qué no está: está cubierto, delante
    // de la cola y de la escritura en Redis. No lo devuelvas aquí.

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

    // Derivada y esperando a una persona (S29): el bot no clasifica ni
    // responde. El mensaje ya quedó registrado arriba, que es lo que importa —
    // la bandeja lo ve y alguien contestará.
    //
    // Antes el bot seguía respondiendo mientras el paciente esperaba, que es
    // desconcertante: pidió una persona y le sigue hablando un robot. Y con el
    // retorno automático de M7 encima, recibía respuestas del bot Y un aviso a
    // las 4 h diciendo que nadie le había contestado.
    if (convo.state === 'NEEDS_HUMAN') {
      // `CANCELAR` explícito sí se atiende: es una acción ya confirmada por el
      // paciente y hacerle esperar a una persona para liberar el turno va en
      // contra de lo único que este producto existe para conseguir.
      // Por voz NO se cancela aquí, y tampoco se ecoa: el bot está callado a
      // propósito y el eco se saltaría el throttle de 4 h de abajo, así que
      // tres audios seguidos serían tres respuestas de un bot que se supone
      // mudo. Cae al aviso normal y quien atienda lee el "cancelar" en la
      // bandeja — que es justo lo bueno de este estado: ya viene alguien.
      if (!fromAudio && parseReminderReply(normalized) === 'CANCEL') {
        await this.handleReminderReply(clinic, convo, 'CANCEL', phone);
        return;
      }
      // Un aviso cada 4 h como mucho: repetir "ya avisé al equipo" en cada
      // mensaje es ruido, y quien está esperando suele escribir varias veces.
      if (await this.claimWaitingNotice(clinicId, chatId)) {
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          this.copy(clinic).waitingForHuman,
        );
      }
      return;
    }

    // Escape universal a humano: desde CUALQUIER paso (con o sin FSM) el paciente
    // puede pedir hablar con una persona y salimos del bot inmediatamente.
    // Palabras sueltas (humano, operador, asesor…) y frases explícitas; ver
    // `isHumanEscape`. `persona` a secas NO deriva (B3). Reseteamos FSM y
    // marcamos NEEDS_HUMAN para la bandeja.
    if (isHumanEscape(normalized)) {
      await this.markNeedsHuman(convo.id, clinic.id);
      await this.reply(
        clinic.wahaSession,
        chatId,
        convo.id,
        await this.resolveHandoffMessage(clinic),
      );
      return;
    }

    // 1) FSM activa: procesamos el paso ANTES de tocar el LLM.
    if (convo.flowStep) {
      await this.handleFlowStep(clinic, convo, normalized, text, fromAudio);
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
        this.pickVariant(this.copy(clinic).pools.closing),
      );
      return;
    }

    if (greeted && isBareGreeting(effectiveNormalized)) {
      const contextual = await this.greetingWithAppointment(clinic, convo);
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

      if (!ambiguous) {
        // Desde una nota de voz no se confirma, no se cancela y no se reagenda.
        // Las dos primeras mutan la cita; `REAGENDAR` no la toca, pero pone la
        // FSM en ASK_SLOT y a partir de ahí el parser de recordatorios queda
        // **inalcanzable**: un "reagendar" mal transcrito secuestra la
        // conversación hasta que el paciente diga "cancelar".
        if (fromAudio) {
          await this.askWrittenConfirmation(
            clinic,
            convo,
            text,
            this.wordFor(clinic, reminderAction),
          );
          return;
        }
        await this.handleReminderReply(clinic, convo, reminderAction, phone);
        return;
      }

      // "sí, quiero agendar una cita" no es una confirmación: es un pedido que
      // arranca con "sí". Si el mensaje nombra otra cosa (agendar, precio,
      // cancelar…), va al clasificador aunque haya un recordatorio esperando.
      if (!asksForSomethingElse(effectiveNormalized)) {
        if (await this.hasConfirmationContext(clinic.id, convo)) {
          // El guard va DEBAJO de esta comprobación a propósito: un "ok,
          // entonces nos vemos el martes" dicho por voz no iba a confirmar
          // nada, y pedirle que lo escriba sería fricción por un riesgo que no
          // existe. Sólo se repregunta lo que de verdad iba a mutar.
          if (fromAudio) {
            await this.askWrittenConfirmation(
              clinic,
              convo,
              text,
              this.wordFor(clinic, reminderAction),
            );
            return;
          }
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
    //
    // El historial va también al clasificador (M3-b/M5): "el martes" es
    // AGENDAR o REPROGRAMAR según lo que se venía hablando, y un "sí" detrás
    // de "¿te la cambio?" no es lo mismo que un "sí" suelto.
    //
    // `IntentService` lo trata como texto no confiable —lo sanea y le dice al
    // modelo que ignore órdenes que vengan dentro—, igual que el RAG.
    const contextLines = await this.buildConversationContext(convo.id);
    const intent = await this.intent.detect(
      effectiveText,
      clinic.locale,
      contextLines,
    );
    switch (intent) {
      case Intent.HABLAR_HUMANO:
        await this.markNeedsHuman(convo.id, clinic.id);
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          await this.resolveHandoffMessage(clinic),
        );
        break;

      case Intent.AGENDAR:
        await this.startFlow(clinic, convo);
        break;

      case Intent.REPROGRAMAR:
        // Mismo secuestro de estado que el `reagendar` determinista de arriba,
        // por otra puerta: aquí lo resolvió el LLM sobre una transcripción, así
        // que hay dos capas de incertidumbre en vez de una.
        if (fromAudio) {
          await this.askWrittenConfirmation(
            clinic,
            convo,
            text,
            this.copy(clinic).wordReschedule,
          );
          break;
        }
        await this.handleReminderReply(clinic, convo, 'RESCHEDULE', phone);
        break;

      case Intent.CANCELAR: {
        const appt = await this.findUpcomingAppointment(clinicId, convo);
        const link = appt ? await this.manageLink(clinic, appt) : null;
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          this.copy(clinic).cancelNeedsWord(link),
        );
        break;
      }

      case Intent.CONFIRMAR:
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          this.copy(clinic).confirmNeedsWord,
        );
        break;

      // "gracias", "perfecto": cierra la conversación, no pide nada. Mismo
      // cierre que el determinista, sin gastar otra llamada.
      case Intent.AGRADECER:
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          this.pickVariant(this.copy(clinic).pools.closing),
        );
        break;

      // "¿cuándo es mi cita?" — pregunta por SU cita, no por la clínica, así
      // que no tiene sentido mandarla al RAG: la respuesta está en la BD.
      case Intent.CONSULTA_CITA: {
        const appt = await this.findUpcomingAppointment(clinicId, convo);
        if (!appt) {
          await this.reply(
            clinic.wahaSession,
            chatId,
            convo.id,
            this.copy(clinic).noAppointmentToTell,
          );
          break;
        }
        const copy = this.copy(clinic);
        const when = this.formatWhen(appt.startAt.toISOString(), clinic);
        const service = appt.service?.name ?? 'consulta';
        // `findUpcomingAppointment` no incluye el profesional (no hace falta en
        // los otros caminos). Lo leemos acotado al tenant.
        const professional =
          (
            await this.prisma.professional.findFirst({
              where: { id: appt.professionalId, clinicId: clinic.id },
              select: { name: true },
            })
          )?.name ?? '';
        const statusLine =
          appt.status === 'CONFIRMADA'
            ? copy.apptConfirmedLine(service, when)
            : copy.apptPendingLine(service, when);
        const link = await this.manageLink(clinic, appt);
        await this.reply(
          clinic.wahaSession,
          chatId,
          convo.id,
          copy.appointmentInfo(service, professional, when, statusLine, link),
        );
        break;
      }

      case Intent.PREGUNTA_FAQ: {
        // RAG sobre FaqChunk: si hay match confiable → respondemos con el
        // texto sintetizado por el LLM desde las fuentes. Si no → handoff a
        // humano (política "prefiero handoff que alucinar").
        const result = await this.knowledge.answer({
          clinicId,
          question: effectiveText,
          // Mismo historial que fue al clasificador: una sola lectura.
          context: contextLines.join('\n') || null,
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
          await this.markNeedsHuman(convo.id, clinic.id);
          await this.reply(
            clinic.wahaSession,
            chatId,
            convo.id,
            await this.resolveHandoffMessage(clinic),
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
        this.copy(clinic).noServices,
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
      this.copy(clinic).askService(list),
    );
  }

  // ─────────────────────────── FSM: dispatch ───────────────────────────

  private async handleFlowStep(
    clinic: Clinic,
    convo: Conversation,
    normalized: string,
    originalText: string,
    fromAudio: boolean,
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
      // El efecto es el mismo que el de `NO`/`CANCELAR` en CONFIRM —tirar el
      // flujo entero— así que la regla tiene que ser la misma. Que el paciente
      // no haya llegado a comprometer una cita todavía no lo hace gratis:
      // pierde el servicio, el profesional y el horario que ya había elegido.
      if (fromAudio) {
        await this.askWrittenConfirmation(
          clinic,
          convo,
          originalText,
          this.copy(clinic).wordCancel,
        );
        return;
      }
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).flowAborted,
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
        await this.handleConfirm(
          clinic,
          convo,
          data,
          normalized,
          originalText,
          fromAudio,
        );
        return;
      case 'AWAITING_NPS_SCORE':
        await this.handleAwaitingNpsScore(
          clinic,
          convo,
          data,
          normalized,
          originalText,
          fromAudio,
        );
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
      await this.replyNotUnderstood(
        clinic,
        convo,
        data,
        this.copy(clinic).notUnderstoodService(this.choiceList(data)),
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
        this.copy(clinic).serviceGone,
      );
      return;
    }
    // La preferencia mencionada de paso ("el martes por la tarde") viaja con
    // el flujo: si solo hay un profesional saltamos directo a los horarios y
    // no habría otro momento para leerla.
    const nextData: FlowData = { serviceId: service.id };
    await this.advanceToProfessional(
      clinic,
      convo,
      nextData,
      service,
      parseSlotPreference(normalized),
    );
  }

  private async advanceToProfessional(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    service: Service,
    preference: SlotPreference | null = null,
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
        this.copy(clinic).noProfessionals,
      );
      return;
    }

    // Solo uno → saltamos directo a ASK_SLOT sin preguntar.
    if (professionals.length === 1) {
      const only = professionals[0];
      const nextData: FlowData = { ...data, professionalId: only.id };
      await this.advanceToSlot(clinic, convo, nextData, service.id, [only.id], {
        preference,
      });
      return;
    }

    // "Cualquier profesional" va al final: la mayoría no tiene preferencia y
    // obligarlos a elegir agrega un paso que no aporta. Ver M4.
    const choices = [
      ...professionals.map((p) => ({ id: p.id, label: p.name })),
      {
        id: BotService.ANY_PROFESSIONAL,
        label: this.copy(clinic).anyProfessionalLabel,
      },
    ];
    const nextData: FlowData = { ...data, choices, invalidCount: 0 };
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { flowStep: 'ASK_PROFESSIONAL', flowData: nextData as object },
    });
    const list = choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      this.copy(clinic).askProfessional(list),
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
    const hasAnyOption = (data.choices ?? []).some(
      (c) => c.id === BotService.ANY_PROFESSIONAL,
    );
    // "cualquiera", "el que sea", "me da igual": `resolveChoice` resuelve por
    // substring del label y no matchea ninguna de esas, que son justo las
    // palabras que usa la gente.
    const choice =
      hasAnyOption && isNoPreferenceChoice(normalized)
        ? {
            id: BotService.ANY_PROFESSIONAL,
            label: this.copy(clinic).anyProfessionalLabel,
          }
        : this.resolveChoice(data.choices ?? [], normalized);
    if (!choice) {
      await this.replyNotUnderstood(
        clinic,
        convo,
        data,
        this.copy(clinic).notUnderstoodProfessional(this.choiceList(data)),
      );
      return;
    }
    const preference = parseSlotPreference(normalized);

    // "Cualquier profesional": ofrecemos los horarios de todos y el dueño de
    // cada slot se fija recién cuando el paciente elige uno.
    if (choice.id === BotService.ANY_PROFESSIONAL) {
      const professionals = await this.prisma.professional.findMany({
        where: {
          clinicId: clinic.id,
          active: true,
          services: { some: { id: data.serviceId } },
        },
        orderBy: { name: 'asc' },
      });
      if (professionals.length === 0) {
        await this.resetFlow(convo.id);
        await this.reply(
          clinic.wahaSession,
          convo.chatId,
          convo.id,
          this.copy(clinic).serviceLostProfessionals,
        );
        return;
      }
      await this.advanceToSlot(
        clinic,
        convo,
        data,
        data.serviceId,
        professionals.map((p) => p.id),
        { preference },
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
        this.copy(clinic).professionalGone,
      );
      return;
    }
    await this.advanceToSlot(
      clinic,
      convo,
      { ...data, professionalId: professional.id },
      data.serviceId,
      [professional.id],
      { preference },
    );
  }

  /**
   * Muestra una página de horarios y deja la FSM en ASK_SLOT.
   *
   * `professionalIds` con un solo id es el caso normal; con varios es el modo
   * "cualquier profesional" (M4), donde cada horario puede ser de uno distinto
   * y guardamos el dueño de cada slot en `offeredProfessionalIds`.
   *
   * `windowCount` es la página: 0 son los próximos 7 días, 1 los 7 siguientes,
   * etc. `preference` filtra la lista antes de mostrarla ("el martes por la
   * tarde"); si el filtro deja la lista vacía lo decimos y mostramos todo, que
   * es mejor que un "no hay nada" que suena a que la agenda está llena.
   */
  /**
   * Campos de `FlowData` atados al PASO actual: la lista que se acaba de
   * mostrar, el horario elegido, los contadores de esa pantalla. Todo lo demás
   * describe QUÉ se está agendando y tiene que sobrevivir a un re-listado.
   */
  private static readonly STEP_SCOPED_FLOW_FIELDS = [
    'startAtISO',
    'offeredSlots',
    'offeredProfessionalIds',
    'anyProfessional',
    'choices',
    'invalidCount',
    'slotWindowCount',
  ] as const satisfies readonly (keyof FlowData)[];

  /**
   * Conserva el contexto del flujo y descarta lo atado al paso actual (S26).
   *
   * **La polaridad es lo importante**: conservar por defecto y descartar solo
   * lo enumerado, no al revés. Antes los re-ofrecimientos de horarios
   * reconstruían `flowData` campo a campo, así que al añadir `rescheduleOf`
   * (B5) se perdía en silencio — y con él, la cita que el paciente quería
   * mover: la FSM seguía como si fuera una cita nueva y acababa con dos.
   *
   * Nada falló al introducir ese bug: ni el compilador, porque todos los
   * campos son opcionales, ni los tests, porque ninguno cubría "re-listar
   * horarios en mitad de un reagendado". Con esta función, un campo nuevo se
   * conserva salvo que alguien lo añada a la lista de arriba a propósito.
   */
  private carryFlowContext(data: FlowData): FlowData {
    const next: FlowData = { ...data };
    for (const field of BotService.STEP_SCOPED_FLOW_FIELDS) {
      delete next[field];
    }
    return next;
  }

  private async advanceToSlot(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    serviceId: string,
    professionalIds: string[],
    opts: {
      windowCount?: number;
      preference?: SlotPreference | null;
      /** Encabezado propio (reagendado: el contexto no es "vamos bien"). */
      intro?: string;
      /** Línea extra al final, p. ej. el link de gestión como alternativa. */
      footer?: string;
    } = {},
  ): Promise<void> {
    const windowCount = opts.windowCount ?? 0;
    const anyProfessional = professionalIds.length > 1;
    const zone = clinic.timezone;
    const now = DateTime.now().setZone(zone);
    const from = now.plus({
      days: windowCount * BotService.SLOT_WINDOW_DAYS,
    });

    // Un getSlots por profesional. Con "cualquiera" el primero que ofrece un
    // horario se lo queda: los profesionales vienen ordenados por nombre, así
    // que el reparto es estable y no depende del orden de las promesas.
    const perProfessional = await Promise.all(
      professionalIds.map(async (professionalId) => {
        const slots = await this.availability.getSlots({
          clinicId: clinic.id,
          serviceId,
          professionalId,
          fromISO: from.toISO() ?? from.toString(),
          days: BotService.SLOT_WINDOW_DAYS,
          limit: 6,
        });
        return slots.map((slot) => ({ slot, professionalId }));
      }),
    );

    const byStart = new Map<number, { slot: Slot; professionalId: string }>();
    for (const entry of perProfessional.flat()) {
      const key = entry.slot.startAt.getTime();
      if (!byStart.has(key)) byStart.set(key, entry);
    }
    const all = [...byStart.values()].sort(
      (a, b) => a.slot.startAt.getTime() - b.slot.startAt.getTime(),
    );

    if (all.length === 0) {
      await this.noSlotsLeft(clinic, convo, data, windowCount);
      return;
    }

    const filtered = opts.preference
      ? this.filterSlotsByPreference(all, opts.preference, clinic)
      : all;
    const preferenceMissed = opts.preference != null && filtered.length === 0;
    const shown = (preferenceMissed ? all : filtered).slice(0, 6);

    // `carryFlowContext` limpia lo del paso anterior: sin él, una lista de
    // "cualquier profesional" dejaba `anyProfessional` y sus ids pegados a la
    // siguiente aunque ya fuera de un profesional concreto.
    const nextData: FlowData = {
      ...this.carryFlowContext(data),
      offeredSlots: shown.map((e) => e.slot.startAt.toISOString()),
      ...(anyProfessional
        ? {
            anyProfessional: true,
            offeredProfessionalIds: shown.map((e) => e.professionalId),
          }
        : {}),
      slotWindowCount: windowCount,
      invalidCount: 0,
    };
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { flowStep: 'ASK_SLOT', flowData: nextData as object },
    });

    const labels = shown.map(
      (e, i) => `${i + 1}. ${this.slotLabel(e.slot, clinic)}`,
    );
    const copy = this.copy(clinic);
    const intro = preferenceMissed
      ? copy.slotsIntroPreferenceMissed
      : windowCount > 0
        ? copy.slotsIntroNextWeek
        : (opts.intro ?? copy.slotsIntro);
    const more =
      windowCount + 1 < BotService.MAX_SLOT_WINDOWS ? copy.slotsMoreOption : '';
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      copy.slotsPrompt(labels.join('\n'), more, opts.footer ?? '', intro),
    );
  }

  /**
   * Sin horarios en esta ventana. En la primera reseteamos (la agenda está
   * realmente vacía); si el paciente ya venía avanzando semanas, mantenemos la
   * FSM y le damos el form web, que le deja ver el calendario entero.
   */
  private async noSlotsLeft(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    windowCount: number,
  ): Promise<void> {
    if (windowCount === 0) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).noSlots,
      );
      return;
    }
    const link = await this.buildSchedulingLink(convo, clinic);
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      this.copy(clinic).agendaExhausted(link),
    );
  }

  /** Filtra por franja horaria y/o día, en la TZ de la clínica. */
  private filterSlotsByPreference(
    entries: Array<{ slot: Slot; professionalId: string }>,
    preference: SlotPreference,
    clinic: Clinic,
  ): Array<{ slot: Slot; professionalId: string }> {
    const zone = clinic.timezone;
    const today = DateTime.now().setZone(zone).startOf('day');
    return entries.filter(({ slot }) => {
      const dt = DateTime.fromJSDate(slot.startAt).setZone(zone);
      if (preference.period === 'manana' && dt.hour >= 12) return false;
      if (preference.period === 'tarde' && dt.hour < 12) return false;
      if (preference.weekday && dt.weekday !== preference.weekday) return false;
      if (preference.relativeDay) {
        const target =
          preference.relativeDay === 'hoy' ? today : today.plus({ days: 1 });
        if (!dt.startOf('day').equals(target)) return false;
      }
      return true;
    });
  }

  private async handleAskSlot(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    normalized: string,
  ): Promise<void> {
    const offered = data.offeredSlots ?? [];
    const windowCount = data.slotWindowCount ?? 0;
    const professionalIds = data.anyProfessional
      ? (data.offeredProfessionalIds ?? [])
      : [];

    // "0" o "más horarios" → siguiente ventana de 7 días (M4).
    const wantsMore =
      /^0\b/.test(normalized) ||
      startsWithAny(normalized, ['mas', 'otros', 'otras', 'siguiente']) ||
      /\bmas (horarios|opciones|fechas)\b/.test(normalized);
    if (wantsMore && data.serviceId) {
      if (windowCount + 1 >= BotService.MAX_SLOT_WINDOWS) {
        const link = await this.buildSchedulingLink(convo, clinic);
        await this.reply(
          clinic.wahaSession,
          convo.chatId,
          convo.id,
          this.copy(clinic).agendaExhaustedWindows(link),
        );
        return;
      }
      const ids = data.anyProfessional
        ? [...new Set(professionalIds)]
        : data.professionalId
          ? [data.professionalId]
          : [];
      if (ids.length > 0) {
        await this.advanceToSlot(clinic, convo, data, data.serviceId, ids, {
          windowCount: windowCount + 1,
          preference: parseSlotPreference(normalized),
        });
        return;
      }
    }

    // Parseamos SOLO por índice para slots (evitar ambigüedades de fecha en texto libre).
    // El paciente puede escribir "1", "2.", "opción 3", etc.
    const match = normalized.match(/\d+/);
    if (!match) {
      // Sin número, pero con una preferencia clara ("mejor por la tarde"):
      // volvemos a listar filtrando, en vez de contestar "no te entendí".
      const preference = parseSlotPreference(normalized);
      if (preference && data.serviceId) {
        const ids = data.anyProfessional
          ? [...new Set(professionalIds)]
          : data.professionalId
            ? [data.professionalId]
            : [];
        if (ids.length > 0) {
          await this.advanceToSlot(clinic, convo, data, data.serviceId, ids, {
            windowCount,
            preference,
          });
          return;
        }
      }
      await this.replyNotUnderstood(
        clinic,
        convo,
        data,
        this.copy(clinic).notUnderstoodSlot(this.offeredSlotList(offered, clinic)),
      );
      return;
    }
    const idx = Number.parseInt(match[0], 10) - 1;
    if (idx < 0 || idx >= offered.length) {
      await this.replyNotUnderstood(
        clinic,
        convo,
        data,
        this.copy(clinic).slotNotInList(offered.length, this.offeredSlotList(offered, clinic)),
      );
      return;
    }
    const startAtISO = offered[idx];
    // En modo "cualquier profesional" el dueño del slot se fija acá.
    const resolvedProfessionalId = data.anyProfessional
      ? professionalIds[idx]
      : data.professionalId;
    if (!resolvedProfessionalId) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).agendaChanged,
      );
      return;
    }

    // Cargamos servicio y profesional para armar el mensaje de confirmación.
    const [service, professional] = await Promise.all([
      this.prisma.service.findFirst({
        where: { id: data.serviceId!, clinicId: clinic.id },
      }),
      this.prisma.professional.findFirst({
        where: { id: resolvedProfessionalId, clinicId: clinic.id },
      }),
    ]);
    if (!service || !professional) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).agendaChanged,
      );
      return;
    }

    const nextData: FlowData = {
      ...data,
      startAtISO,
      professionalId: resolvedProfessionalId,
      invalidCount: 0,
    };

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
        this.copy(clinic).confirmPrompt(
        existingPatient.name,
        service.name,
        professional.name,
        when,
      ),
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
      this.copy(clinic).askName,
    );
  }

  /**
   * Responde un "no te entendí" y cuenta cuántos van seguidos en este paso.
   * A partir del segundo ofrecemos el form web como salida — sin resetear la
   * FSM: el paciente puede seguir por chat si prefiere, y quien se atascó
   * tiene una puerta en vez de repetir la lista una tercera vez (M4).
   */
  private async replyNotUnderstood(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    message: string,
  ): Promise<void> {
    const invalidCount = (data.invalidCount ?? 0) + 1;
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { flowData: { ...data, invalidCount } as object },
    });

    if (invalidCount < BotService.MAX_INVALID_RETRIES) {
      await this.reply(clinic.wahaSession, convo.chatId, convo.id, message);
      return;
    }

    const link = await this.buildSchedulingLink(convo, clinic);
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      this.copy(clinic).webFallback(message, link),
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
        this.copy(clinic).askNameAgain,
      );
      return;
    }
    if (!data.serviceId || !data.professionalId || !data.startAtISO) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).flowLost,
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
        this.copy(clinic).agendaChanged,
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
      this.copy(clinic).confirmPrompt(
        cleaned,
        service.name,
        professional.name,
        when,
      ),
    );
  }

  /**
   * Repite lo que se entendió y pide que lo escriban, en vez de actuar.
   *
   * Por qué existe: la transcripción de una nota de voz entra al pipeline como
   * si el paciente la hubiera escrito, y ahí deja de distinguirse de un
   * mensaje que él leyó antes de mandar. Para casi todo da igual — si el bot
   * entiende mal "quiero agendar", el paciente lo corrige en el siguiente
   * mensaje. Pero para confirmar o cancelar una cita no: un "sí" es un golpe
   * de voz de una sílaba, el proveedor no nos devuelve ninguna señal de
   * confianza, y el resultado de equivocarse es una cita confirmada que el
   * paciente nunca pidió o una cancelada que sí quería.
   *
   * La asimetría es la clave: pedir que lo escriban cuesta un mensaje; actuar
   * sobre una transcripción dudosa cuesta una cita.
   *
   * No cambia el estado: la FSM se queda donde estaba y el recordatorio sigue
   * pendiente, así que el siguiente mensaje escrito sigue el camino normal.
   *
   * **A la segunda vez deriva a una persona.** Sin eso esto es una trampa: el
   * paciente que manda notas de voz suele ser el que peor escribe (mayores,
   * gente manejando, baja alfabetización), y repetirle "escríbemelo" en bucle
   * lo deja sin ningún camino hacia su cita — encima saltándose la escalera de
   * rescate de la FSM, que este guard cortocircuita al hacer `return`.
   */
  /** La palabra que hay que escribir para cada acción, en el idioma de la clínica. */
  private wordFor(clinic: Clinic, action: ReminderReplyAction): string {
    const copy = this.copy(clinic);
    if (action === 'YES') return copy.wordYes;
    if (action === 'CANCEL') return copy.wordCancel;
    return copy.wordReschedule;
  }

  private async askWrittenConfirmation(
    clinic: Clinic,
    convo: Conversation,
    heard: string,
    palabra: string,
  ): Promise<void> {
    if (!(await this.claimVoiceConfirmAttempt(clinic.id, convo.chatId))) {
      await this.markNeedsHuman(convo.id, clinic.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).voiceConfirmHandoff,
      );
      return;
    }

    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      this.copy(clinic).voiceConfirmEcho(this.echoable(heard), palabra),
    );
  }

  /**
   * Deja el texto del paciente en condiciones de volver dentro de un mensaje.
   *
   * No es cosmética: este eco se persiste como `Message OUT` y
   * `buildConversationContext` lo reinyecta al clasificador y al RAG etiquetado
   * como **`Asistente:`**. Es la única ruta por la que texto del paciente se
   * promueve a la voz del bot, así que se le quitan los caracteres de control y
   * el marcado (`*`, `_`, backticks) que podrían fabricar énfasis o confundir
   * al prompt, y se colapsan los saltos de línea.
   */
  private echoable(heard: string): string {
    const limpio = heard
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return limpio.length > BotService.ECHO_MAX_CHARS
      ? `${limpio.slice(0, BotService.ECHO_MAX_CHARS).trimEnd()}…`
      : limpio;
  }

  /**
   * Primera nota de voz de confirmación en la ventana: `true`. La segunda
   * devuelve `false` y el caller deriva a una persona.
   *
   * Fail-closed **hacia la persona**: si Redis no responde no sabemos si es la
   * primera o la quinta, y dejar a alguien dando vueltas en un bucle es peor
   * que abrirle un hilo en la bandeja. Es lo contrario del throttle del aviso
   * de espera, que ante la duda calla — allí el riesgo es el ruido, aquí es que
   * el paciente se quede sin cita.
   */
  private async claimVoiceConfirmAttempt(
    clinicId: string,
    chatId: string,
  ): Promise<boolean> {
    try {
      const result = await this.redis.set(
        `bot:voice-confirm:${clinicId}:${chatId}`,
        '1',
        'EX',
        BotService.VOICE_CONFIRM_TTL_SEC,
        'NX',
      );
      return result !== null;
    } catch (e) {
      this.logger.warn(
        `intento de confirmación por voz no contabilizado (redis) clinic=${clinicId}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  private async handleConfirm(
    clinic: Clinic,
    convo: Conversation,
    data: FlowData,
    normalized: string,
    originalText: string,
    fromAudio: boolean,
  ): Promise<void> {
    const action = this.parseFlowConfirmReply(normalized);

    // Desde una nota de voz, `SÍ` crea la cita y `NO`/`CANCELAR` tiran el flujo
    // entero: las tres se piden por escrito. `REAGENDAR` no, porque no cierra
    // nada — vuelve a ofrecer horarios conservando los datos, y el paciente
    // todavía tiene que elegir uno. Ver `askWrittenConfirmation`.
    if (fromAudio && action && action !== 'RESCHEDULE') {
      const copy = this.copy(clinic);
      await this.askWrittenConfirmation(
        clinic,
        convo,
        originalText,
        action === 'YES' ? copy.wordYes : copy.wordCancel,
      );
      return;
    }

    if (!action) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).confirmOnlyYesOrNo,
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
        this.copy(clinic).nothingScheduled,
      );
      return;
    }

    if (!data.serviceId || !data.professionalId || !data.startAtISO) {
      await this.resetFlow(convo.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).flowLost,
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
        this.copy(clinic).needPhone(link),
      );
      return;
    }

    try {
      // B5: con `rescheduleOf` la cita se MUEVE, no se crea otra. Mismo id,
      // mismo paciente; `rescheduleAppointment` reprograma los recordatorios y
      // lleva el contador de movimientos. Crear+cancelar inflaría `CANCELADA` y
      // diluiría el no-show rate.
      const appt = data.rescheduleOf
        ? await this.scheduling.rescheduleAppointment({
            clinicId: clinic.id,
            appointmentId: data.rescheduleOf,
            startAtISO: data.startAtISO,
            byPatient: true,
            maxPatientReschedules: BotService.MAX_PATIENT_RESCHEDULES,
          })
        : (
            await this.scheduling.createAppointment({
              clinicId: clinic.id,
              // Solo pasamos `name` si lo recolectamos en ASK_NAME. Si el
              // paciente ya existía con nombre, no lo mandamos → el upsert
              // respeta el valor previo.
              patient: {
                phone: convo.phone,
                ...(data.patientName ? { name: data.patientName } : {}),
              },
              serviceId: data.serviceId,
              professionalId: data.professionalId,
              startAtISO: data.startAtISO,
              source: 'BOT',
            })
          ).appointment;

      // S5: la cita nació de este chat y el teléfono es el de WAHA, así que
      // la conversación queda ligada al paciente. A partir de acá el
      // recordatorio-respuesta y el follow-up la encuentran aunque el chat
      // pase a `@lid` y perdamos el teléfono.
      if (appt.patientId) {
        await this.linkConversationPatient(convo.id, clinic.id, appt.patientId);
      }

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
      const copy = this.copy(clinic);
      const status = data.rescheduleOf
        ? copy.status.moved
        : appt.status === 'CONFIRMADA'
          ? copy.status.confirmed
          : copy.status.scheduled;
      // Link de gestión en el cierre: el paciente lo tiene a mano desde el
      // primer momento, sin tener que volver a escribir (M2-c).
      const manageUrl = await this.manageLink(clinic, appt);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.resolveConfirmMessage({
          copy,
          status,
          when,
          clinicName: clinic.name,
          address,
          service: confirmed.service?.name ?? 'consulta',
          professional: confirmed.professional?.name ?? 'el profesional',
          manageUrl,
        }),
      );
    } catch (e) {
      if (e instanceof ConflictException) {
        // Los dos 409 de `rescheduleAppointment` piden respuestas OPUESTAS: el
        // slot ocupado invita a elegir otro horario, el tope a hablar con una
        // persona. Confundirlos no daba un mensaje raro, daba un bucle:
        // re-ofrecer → elegir → fallar → re-ofrecer.
        //
        // Se distinguen por tipo desde S25. Antes se comparaba el texto del
        // mensaje, que se rompía con cualquier reescritura de copy sin que
        // fallara nada.
        if (e instanceof RescheduleLimitExceededException) {
          await this.resetFlow(convo.id);
          const link = data.rescheduleOf
            ? await this.manageLink(clinic, {
                id: data.rescheduleOf,
                clinicId: clinic.id,
                startAt: new Date(data.startAtISO!),
              })
            : null;
          await this.markNeedsHuman(convo.id, clinic.id);
          await this.reply(
            clinic.wahaSession,
            convo.chatId,
            convo.id,
            this.copy(clinic).rescheduleLimit(link),
          );
          return;
        }
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
        this.copy(clinic).createFailed,
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
        this.copy(clinic).flowLost,
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
        this.copy(clinic).noSlotsLeftForPair,
      );
      return;
    }

    const offeredSlots = slots.map((s) => s.startAt.toISOString());
    const labels = slots.map((s, i) => `${i + 1}. ${this.slotLabel(s, clinic)}`);
    // Conservamos el contexto del flujo y descartamos el startAtISO viejo (ese
    // era el que se acababa de ocupar). Ver `carryFlowContext`.
    const nextData: FlowData = {
      ...this.carryFlowContext(data),
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
      this.copy(clinic).slotTaken(labels.join('\n')),
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
        this.copy(clinic).flowLost,
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
        this.copy(clinic).noSlotsLeftForPair,
      );
      return;
    }

    const offeredSlots = slots.map((s) => s.startAt.toISOString());
    const labels = slots.map((s, i) => `${i + 1}. ${this.slotLabel(s, clinic)}`);
    // Mismo criterio que en el re-ofrecimiento por conflicto: el contexto del
    // flujo viaja entero, lo del paso anterior se descarta.
    const nextData: FlowData = {
      ...this.carryFlowContext(data),
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
      this.copy(clinic).slotExpired(labels.join('\n')),
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
   *  2. Hay un `Reminder` con `status = SENT` en las últimas 48 h para la cita
   *     próxima de esta conversación — el recordatorio anti no-show, que puede
   *     llegar días después del último mensaje.
   *
   * La cita sale de `findUpcomingAppointment`, así que hereda el orden
   * `patientId → conversationId → phone` de S5 y funciona también en un chat
   * `@lid` sin teléfono. El `Reminder` se busca por `appointmentId`, que ya
   * viene acotado al tenant.
   */
  private async hasConfirmationContext(
    clinicId: string,
    convo: Pick<Conversation, 'id' | 'phone' | 'patientId'>,
  ): Promise<boolean> {
    // Sólo el último, y por eso el eco del guard de notas de voz (M10) tiene
    // que llevar la misma palabra en negrita que la pregunta a la que
    // responde: ese eco se persiste como `OUT` y se interpone entre la
    // pregunta que pedía confirmar y el "sí" que el paciente escribe después.
    // Con la palabra dentro, el eco conserva el contexto en vez de borrarlo;
    // sin ella, el guard invalidaba la respuesta que él mismo había pedido.
    const lastOut = await this.prisma.message.findFirst({
      where: { conversationId: convo.id, direction: 'OUT' },
      orderBy: { createdAt: 'desc' },
      select: { body: true },
    });
    if (lastOut && /\*s[ií]\*/i.test(lastOut.body)) return true;

    const appt = await this.findUpcomingAppointment(clinicId, convo);
    if (!appt) return false;

    // `minus({ hours })` sobre instantes: el resultado no depende de la zona,
    // así que acá no hace falta la TZ de la clínica (a diferencia de todo lo
    // que se le muestra al paciente, que sí va en su zona).
    const reminder = await this.prisma.reminder.findFirst({
      where: {
        appointmentId: appt.id,
        status: 'SENT',
        sentAt: {
          gte: DateTime.now()
            .minus({ hours: BotService.REMINDER_REPLY_WINDOW_H })
            .toJSDate(),
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
    // S5: resolvemos ANTES de mirar el teléfono. Una conversación ligada por
    // `patientId`, o con una cita nacida de este mismo chat, se gestiona sin
    // teléfono — que es justo el caso `@lid` que motivó el ítem.
    const appt = await this.findUpcomingAppointment(clinic.id, convo);
    if (!appt) {
      if (!phone) {
        // Sin cita y sin teléfono no hay nada a lo que agarrarse.
        await this.reply(
          clinic.wahaSession,
          convo.chatId,
          convo.id,
          this.copy(clinic).cannotLinkChat,
        );
        await this.markNeedsHuman(convo.id, clinic.id);
        return;
      }
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).noUpcomingAppointment,
      );
      return;
    }

    if (action === 'YES') {
      await this.reminders.confirmAppointment(appt.id);
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).appointmentConfirmed,
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
        this.copy(clinic).appointmentCanceled,
      );
      return;
    }

    // Reagendar por chat (B5): le ofrecemos los horarios del MISMO servicio y
    // profesional aquí mismo, y el link de gestión como alternativa para quien
    // prefiera ver un calendario. La cita se mueve in-place en CONFIRM.
    //
    // NO cancelamos los recordatorios: la cita sigue en pie mientras no la
    // mueva, y apagarlos aquí la dejaba sin red justo cuando más riesgo de
    // no-show tiene (M2-c).
    const link = await this.manageLink(clinic, appt);
    const footer = link
      ? this.copy(clinic).rescheduleFooter(link)
      : '';

    if (!appt.serviceId || !appt.professionalId) {
      // Cita sin servicio o profesional resolubles: no podemos listar horarios
      // comparables, así que el link (o recepción) es el único camino honesto.
      if (!link) {
        await this.markNeedsHuman(convo.id, clinic.id);
        await this.reply(
          clinic.wahaSession,
          convo.chatId,
          convo.id,
          this.copy(clinic).cannotLinkChat,
        );
        return;
      }
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).rescheduleSlots(link),
      );
      return;
    }

    await this.advanceToSlot(
      clinic,
      convo,
      {
        serviceId: appt.serviceId,
        professionalId: appt.professionalId,
        rescheduleOf: appt.id,
      },
      appt.serviceId,
      [appt.professionalId],
      {
        intro: this.copy(clinic).slotsIntroReschedule,
        footer,
      },
    );
  }

  private async markNeedsHuman(
    convoId: string,
    clinicId?: string,
  ): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: convoId },
      data: {
        state: 'NEEDS_HUMAN',
        flowStep: null,
        flowData: Prisma.JsonNull,
      },
    });

    // M7: si nadie la toma en unas horas, el bot recupera el control. Sin esto
    // una conversación derivada un viernes a las 21:00 se queda muda hasta que
    // alguien entre al panel el lunes.
    //
    // Fail-open: si la cola no responde, el handoff sigue siendo válido — lo
    // que se pierde es el rescate, no la derivación.
    if (!clinicId) return;
    try {
      await this.handoffQueue.add(
        'handoff-timeout',
        { conversationId: convoId, clinicId },
        {
          delay: HANDOFF_TIMEOUT_HOURS * 60 * 60 * 1000,
          jobId: `handoff:${convoId}`,
        },
      );
    } catch (e) {
      this.logger.error(
        `no se pudo programar el retorno del handoff convoId=${convoId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Mensaje de handoff con la expectativa REAL (M7).
   *
   * "Enseguida te atiende una persona" a las 22:00 de un sábado es mentira, y
   * una mentira que el paciente descubre esperando. Si estamos fuera del
   * horario de la clínica decimos cuándo responden, con el mismo texto que usa
   * el bloque de hechos del RAG.
   *
   * Sin `BusinessHour` cargado caemos al mensaje genérico: no podemos prometer
   * un horario que nadie configuró.
   */
  private async resolveHandoffMessage(clinic: Clinic): Promise<string> {
    const base = this.resolveBotMessage(clinic, 'handoff');
    try {
      const rows = await this.prisma.businessHour.findMany({
        where: { clinicId: clinic.id, professionalId: null },
      });
      if (rows.length === 0) return base;

      const now = DateTime.now().setZone(clinic.timezone);
      if (isWithinBusinessHours(rows, now)) return base;

      const schedule = formatSchedule(rows);
      if (!schedule) return base;
      return `Le paso tu mensaje al equipo. Te responden en horario de atención: ${schedule}`;
    } catch (e) {
      this.logger.warn(
        `handoff sin horario real clinicId=${clinic.id}: ${(e as Error).message}`,
      );
      return base;
    }
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
    originalText: string,
    fromAudio: boolean,
  ): Promise<void> {
    const apptId = data.feedbackAppointmentId;
    if (!apptId) {
      // Estado corrupto: caemos gracefully al reset.
      await this.resetFlow(convo.id);
      return;
    }

    const score = this.parseNpsScore(normalized);

    // `recordFeedback` es create-once: un "cinco" mal transcrito queda como la
    // nota **permanente** de esa visita y el paciente ya no puede corregirla.
    // Es más irreversible que una cita, que al menos se reagenda.
    if (fromAudio && score !== null) {
      await this.askWrittenConfirmation(
        clinic,
        convo,
        originalText,
        String(score),
      );
      return;
    }

    if (score === null) {
      await this.reply(
        clinic.wahaSession,
        convo.chatId,
        convo.id,
        this.copy(clinic).npsInvalid,
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
        this.copy(clinic).npsThanks,
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
      this.copy(clinic).npsAskComment,
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
      // La fila de Feedback ya existe (la creó el paso del score), así que
      // solo actualizamos el comentario. Vía `FollowUpsService.recordComment`,
      // que filtra por `clinicId` además de por `appointmentId`: un
      // `feedback.update` por `appointmentId` suelto escribiría sobre la fila
      // de otra clínica si `flowData` quedara con un id ajeno. Ver S4.
      await this.followUps.recordComment(clinic.id, apptId, originalText);
    }

    await this.resetFlow(convo.id);
    await this.reply(
      clinic.wahaSession,
      convo.chatId,
      convo.id,
      this.copy(clinic).npsDone,
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

  /**
   * Próxima cita abierta que le corresponde a ESTA conversación (S5).
   *
   * Tres vías, en orden, quedándose con la primera que devuelva algo:
   *
   *  1. `convo.patientId` si ya está ligado — lo más preciso, y lo único que
   *     funciona en un chat `@lid` sin teléfono.
   *  2. `appointment.conversationId = convo.id` — la cita nació de este chat
   *     (link tokenizado). Deja que un `@lid` gestione **sus propias** citas
   *     sin heredar el historial de un teléfono que no verificamos.
   *  3. El `phone` de la conversación — el que reporta WAHA, no uno declarado
   *     en un formulario. Si por esa vía aparece un `Patient` y la
   *     conversación no tenía `patientId`, lo ligamos de paso: a partir de ahí
   *     entra por la vía 1.
   *
   * Nunca se liga a partir de un teléfono declarado: ver
   * `docs/notas/2026-09-11-conversation-patient-link.md`.
   */
  private async findUpcomingAppointment(
    clinicId: string,
    convo: Pick<Conversation, 'id' | 'phone' | 'patientId'>,
  ) {
    const openAndFuture = {
      clinicId,
      status: { in: [...BotService.upcomingAppointmentStatuses] },
      startAt: { gte: DateTime.now().toJSDate() },
    };
    const pick = {
      orderBy: { startAt: 'asc' },
      include: { service: true, patient: true },
    } as const;

    if (convo.patientId) {
      const byPatient = await this.prisma.appointment.findFirst({
        where: {
          ...openAndFuture,
          patientId: convo.patientId,
          // Si la conversación tiene teléfono verificado por WAHA, el paciente
          // ligado tiene que ser el de ese número. Un enlace viejo que ya no
          // corresponde no puede ganarle al teléfono verificado: caeríamos en
          // la vía (c), que además lo corrige.
          ...(convo.phone ? { patient: { phone: convo.phone } } : {}),
        },
        ...pick,
      });
      if (byPatient) return byPatient;
    }

    const byConversation = await this.prisma.appointment.findFirst({
      where: { ...openAndFuture, conversationId: convo.id },
      ...pick,
    });
    if (byConversation) return byConversation;

    if (!convo.phone) return null;
    const patient = await this.prisma.patient.findUnique({
      where: { clinicId_phone: { clinicId, phone: convo.phone } },
    });
    if (!patient) return null;

    // Oportunista: el teléfono es el verificado por WAHA, así que ligar es
    // seguro y evita repetir esta búsqueda en cada mensaje. También corrige un
    // enlace anterior que apunte a otro paciente — el número verificado manda.
    if (convo.patientId !== patient.id) {
      await this.linkConversationPatient(convo.id, clinicId, patient.id);
    }

    return this.prisma.appointment.findFirst({
      where: { ...openAndFuture, patientId: patient.id },
      ...pick,
    });
  }

  /**
   * Liga `Conversation.patientId`. `updateMany` con `clinicId` en el `where`:
   * un `update` por `id` suelto escribiría sin comprobar el tenant, que es el
   * patrón que la convención del repo prohíbe.
   *
   * Nunca toca `phone`: el único teléfono en el que confiamos es el que
   * reporta WAHA.
   */
  private async linkConversationPatient(
    conversationId: string,
    clinicId: string,
    patientId: string,
  ): Promise<void> {
    // El `updateMany` acota la CONVERSACIÓN al tenant, pero el `patientId` lo
    // pone el caller. La FK no comprueba clínica, así que una fila
    // `Conversation(clínica A) → Patient(clínica B)` quedaría persistida y el
    // panel, que resuelve por `patientId`, sí cruzaría. Hoy los tres callers
    // pasan un paciente ya acotado; esto es defensa en profundidad.
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, clinicId },
      select: { id: true },
    });
    if (!patient) {
      this.logger.error(
        `link conversation/patient rechazado: el paciente no es de esta clínica convoId=${conversationId} clinicId=${clinicId}`,
      );
      return;
    }

    const { count } = await this.prisma.conversation.updateMany({
      where: { id: conversationId, clinicId },
      data: { patientId },
    });
    if (count > 0) {
      // Traza sin PII: en un incidente, saber qué chat quedó ligado a qué
      // paciente es justo lo que hace falta. Ni teléfono ni nombre.
      this.logger.log(
        `conversation ligada a paciente convoId=${conversationId} patientId=${patientId} clinicId=${clinicId}`,
      );
    }
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
