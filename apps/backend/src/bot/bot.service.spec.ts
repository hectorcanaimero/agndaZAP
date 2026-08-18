import { BadRequestException, ConflictException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { FollowUpsService } from '../follow-ups/follow-ups.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { RemindersService } from '../reminders/reminders.service';
import { AvailabilityService } from '../scheduling/availability.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { WahaService } from '../whatsapp/waha.service';
import { BotService } from './bot.service';
import { Intent, IntentService } from './intent.service';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

function makeClinic(overrides: Partial<any> = {}) {
  return {
    id: 'clinic-A',
    name: 'Clínica A',
    slug: 'clinica-a',
    timezone: 'America/Caracas',
    locale: 'es',
    wahaSession: 'clinic-a-session',
    autoConfirm: false,
    address: 'Av. Siempre Viva 123',
    ...overrides,
  };
}

describe('BotService — FSM de agendamiento', () => {
  let prisma: Deep<PrismaService>;
  let waha: Deep<WahaService>;
  let reminders: Deep<RemindersService>;
  let followUps: Deep<FollowUpsService>;
  let intent: Deep<IntentService>;
  let availability: Deep<AvailabilityService>;
  let scheduling: Deep<SchedulingService>;
  let knowledge: Deep<KnowledgeService>;
  /**
   * Fake Redis stateful: mantiene contadores in-memory por key para poder
   * simular ventanas de rate-limit (ADR 0007). Tests que no invocan al bot
   * >15 veces en el mismo minuto quedan bajo el cap y no ven diferencia.
   */
  let redisCounters: Map<string, number>;
  let redis: { incr: jest.Mock; expire: jest.Mock };
  let bot: BotService;

  const zone = 'America/Caracas';
  const tomorrow10 = DateTime.now()
    .setZone(zone)
    .plus({ days: 1 })
    .set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  const tomorrow1030 = tomorrow10.plus({ minutes: 30 });

  const service1 = {
    id: 'svc-1',
    clinicId: 'clinic-A',
    name: 'Consulta general',
    durationMin: 30,
    bufferMin: 0,
    active: true,
  };
  const professional1 = {
    id: 'prof-1',
    clinicId: 'clinic-A',
    name: 'Dra. Ríos',
    active: true,
  };

  /** Almacena el estado de Conversation entre updates (mock stateful). */
  let convoState: any;

  beforeEach(() => {
    // Bot typing indicator: OFF en tests para no meter sleeps reales de 700ms+
    // en cada `reply()`. La lógica del typing la testeamos aparte (unit del
    // wrapper `reply` con jest.useFakeTimers) — acá el foco es la FSM.
    process.env.BOT_TYPING_ENABLED = 'false';

    // Pool de variantes en `DEFAULT_BOT_MESSAGES`: fijamos `Math.random`
    // en 0 para que `pickVariant` siempre devuelva la PRIMERA variante.
    // Así los asserts históricos que buscan tokens ("persona del equipo",
    // etc.) siguen matcheando sin tener que enumerar todas las variantes.
    jest.spyOn(Math, 'random').mockReturnValue(0);

    convoState = {
      id: 'convo-1',
      clinicId: 'clinic-A',
      chatId: '5804141234567@c.us',
      phone: '+584141234567',
      state: 'BOT',
      flowStep: null,
      flowData: null,
    };

    prisma = {
      clinic: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeClinic()),
        findUnique: jest.fn().mockResolvedValue(makeClinic()),
      },
      conversation: {
        upsert: jest.fn().mockImplementation(async () => convoState),
        update: jest.fn().mockImplementation(async ({ data }: any) => {
          if ('flowStep' in data) convoState.flowStep = data.flowStep;
          if ('flowData' in data) convoState.flowData = data.flowData ?? null;
          if ('state' in data) convoState.state = data.state;
          return convoState;
        }),
      },
      message: {
        create: jest.fn().mockResolvedValue({}),
      },
      service: {
        findMany: jest.fn().mockResolvedValue([service1]),
        findFirst: jest.fn().mockResolvedValue(service1),
      },
      professional: {
        findMany: jest.fn().mockResolvedValue([professional1]),
        findFirst: jest.fn().mockResolvedValue(professional1),
      },
      patient: { findUnique: jest.fn().mockResolvedValue(null) },
      appointment: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    waha = {
      sendText: jest.fn().mockResolvedValue(undefined),
      // Avatar refresh corre en background en cada handleIncoming — mockeamos
      // para no ensuciar los logs con warns de "getContactAvatar is not a function".
      getContactAvatar: jest.fn().mockResolvedValue(null),
      // Typing indicator (`BotService.reply` los invoca antes del sendText,
      // salvo que BOT_TYPING_ENABLED=false). Mockeados para no explotar.
      startTyping: jest.fn().mockResolvedValue(undefined),
      stopTyping: jest.fn().mockResolvedValue(undefined),
    };
    reminders = {
      scheduleForAppointment: jest.fn(),
      cancelForAppointment: jest.fn(),
      confirmAppointment: jest.fn(),
    };
    followUps = {
      scheduleForAppointment: jest.fn().mockResolvedValue(undefined),
      cancelForAppointment: jest.fn().mockResolvedValue(undefined),
      recordFeedback: jest.fn().mockResolvedValue({ created: true }),
    };
    intent = { detect: jest.fn().mockResolvedValue(Intent.AGENDAR) };
    availability = {
      getSlots: jest.fn().mockResolvedValue([
        { startAt: tomorrow10.toJSDate(), endAt: tomorrow1030.toJSDate() },
      ]),
    };
    scheduling = {
      createAppointment: jest.fn().mockResolvedValue({
        id: 'appt-new',
        status: 'PENDIENTE',
        startAt: tomorrow10.toJSDate(),
        endAt: tomorrow1030.toJSDate(),
      }),
    };
    knowledge = {
      answer: jest.fn().mockResolvedValue(null),
    };

    redisCounters = new Map();
    redis = {
      incr: jest.fn().mockImplementation(async (key: string) => {
        const next = (redisCounters.get(key) ?? 0) + 1;
        redisCounters.set(key, next);
        return next;
      }),
      expire: jest.fn().mockResolvedValue(1),
    };

    bot = new BotService(
      prisma as unknown as PrismaService,
      waha as unknown as WahaService,
      reminders as unknown as RemindersService,
      followUps as unknown as FollowUpsService,
      intent as unknown as IntentService,
      availability as unknown as AvailabilityService,
      scheduling as unknown as SchedulingService,
      knowledge as unknown as KnowledgeService,
      redis as any,
    );
  });

  // Scenario Gherkin: Paciente agenda en un horario disponible (E2E de la FSM)
  it('flujo end-to-end: agendar → nombre → confirmar → cita creada + recordatorios programados', async () => {
    // Turn 1: usuario pide "quiero agendar" → intent AGENDAR → como hay 1 servicio,
    // salta directo a ASK_PROFESSIONAL, y como hay 1 profesional, salta a ASK_SLOT.
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'quiero agendar',
    });

    expect(convoState.flowStep).toBe('ASK_SLOT');
    expect(availability.getSlots).toHaveBeenCalledTimes(1);
    const askSlotMsg = waha.sendText.mock.calls.at(-1)![2];
    expect(askSlotMsg).toMatch(/horarios? disponibles/i);

    // Turn 2: usuario elige "1" (el único slot ofrecido). Como el paciente NO
    // existe en DB (findUnique → null), la FSM va a ASK_NAME.
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '1',
    });

    expect(convoState.flowStep).toBe('ASK_NAME');
    const askNameMsg = waha.sendText.mock.calls.at(-1)![2];
    expect(askNameMsg).toMatch(/¿A nombre de quién/i);

    // Turn 3: usuario responde con su nombre → pasa a CONFIRM.
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'Ana Pérez',
    });

    expect(convoState.flowStep).toBe('CONFIRM');
    const confirmMsg = waha.sendText.mock.calls.at(-1)![2];
    expect(confirmMsg).toMatch(/confirmo/i);
    expect(confirmMsg).toMatch(/Ana Pérez/);
    expect(confirmMsg).toMatch(/Dra\. Ríos/);

    // Turn 4: usuario confirma "sí" → se crea la cita.
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'sí',
    });

    expect(scheduling.createAppointment).toHaveBeenCalledTimes(1);
    const call = scheduling.createAppointment.mock.calls[0][0];
    expect(call.clinicId).toBe('clinic-A');
    expect(call.serviceId).toBe('svc-1');
    expect(call.professionalId).toBe('prof-1');
    expect(call.source).toBe('BOT');
    expect(call.patient.phone).toBe('+584141234567');
    // Nombre recolectado en ASK_NAME viaja a SchedulingService.
    expect(call.patient.name).toBe('Ana Pérez');

    // FSM reseteada
    expect(convoState.flowStep).toBeNull();
    // Mensaje final con dirección
    const finalMsg = waha.sendText.mock.calls.at(-1)![2];
    expect(finalMsg).toMatch(/agendada|confirmada/);
    expect(finalMsg).toMatch(/Av\. Siempre Viva/);
  });

  it('si el paciente ya tiene nombre en DB, la FSM salta ASK_NAME y va directo a CONFIRM', async () => {
    // Paciente existente con nombre → no debemos pedirlo de nuevo (ni pisarlo).
    prisma.patient.findUnique.mockResolvedValue({
      id: 'pat-1',
      clinicId: 'clinic-A',
      phone: '+584141234567',
      name: 'Ana Existente',
    });

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    expect(convoState.flowStep).toBe('ASK_SLOT');

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '1',
    });
    // NO pasa por ASK_NAME.
    expect(convoState.flowStep).toBe('CONFIRM');
    const confirmMsg = waha.sendText.mock.calls.at(-1)![2];
    expect(confirmMsg).toMatch(/Ana Existente/);

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'sí',
    });

    expect(scheduling.createAppointment).toHaveBeenCalledTimes(1);
    // No pasamos `name`: dejamos que el upsert de SchedulingService respete el existente.
    const call = scheduling.createAppointment.mock.calls[0][0];
    expect(call.patient.name).toBeUndefined();
  });

  // Scenario Gherkin: No se permite doble reserva (409 desde scheduling)
  // Nuevo comportamiento: el bot re-lista slots libres en vez de resetear.
  it('si scheduling tira ConflictException el bot re-lista horarios libres y vuelve a ASK_SLOT', async () => {
    // Paciente ya existente con nombre → saltamos ASK_NAME (simplifica el test).
    prisma.patient.findUnique.mockResolvedValue({
      id: 'pat-1',
      clinicId: 'clinic-A',
      phone: '+584141234567',
      name: 'Ana Existente',
    });

    scheduling.createAppointment.mockRejectedValueOnce(
      new ConflictException('slot ya tomado'),
    );

    // Segunda consulta de slots debe devolver una nueva lista con dos horarios.
    const tomorrow11 = tomorrow10.plus({ hours: 1 });
    const tomorrow1130 = tomorrow11.plus({ minutes: 30 });
    availability.getSlots
      .mockResolvedValueOnce([
        { startAt: tomorrow10.toJSDate(), endAt: tomorrow1030.toJSDate() },
      ])
      .mockResolvedValueOnce([
        { startAt: tomorrow11.toJSDate(), endAt: tomorrow1130.toJSDate() },
      ]);

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '1',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'sí',
    });

    // La FSM NO se reseteó — quedó en ASK_SLOT re-ofreciendo horarios nuevos.
    expect(convoState.flowStep).toBe('ASK_SLOT');
    expect(availability.getSlots).toHaveBeenCalledTimes(2);
    const msg = waha.sendText.mock.calls.at(-1)![2];
    expect(msg).toMatch(/acaba de ocuparse|quedan libres/i);
    // El nuevo slot ofrecido está en la data.
    expect((convoState.flowData as any).offeredSlots).toHaveLength(1);
    // Preserva el nombre recolectado o existente.
    expect((convoState.flowData as any).serviceId).toBe('svc-1');
    expect((convoState.flowData as any).professionalId).toBe('prof-1');
  });

  it('si tras el conflicto no quedan slots libres, la FSM se resetea con mensaje amable', async () => {
    prisma.patient.findUnique.mockResolvedValue({
      id: 'pat-1',
      clinicId: 'clinic-A',
      phone: '+584141234567',
      name: 'Ana Existente',
    });

    scheduling.createAppointment.mockRejectedValueOnce(
      new ConflictException('slot ya tomado'),
    );

    // Primera llamada (para ASK_SLOT inicial): devuelve un slot.
    // Segunda llamada (re-listado tras conflicto): vacía.
    availability.getSlots
      .mockResolvedValueOnce([
        { startAt: tomorrow10.toJSDate(), endAt: tomorrow1030.toJSDate() },
      ])
      .mockResolvedValueOnce([]);

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '1',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'sí',
    });

    expect(convoState.flowStep).toBeNull();
    const msg = waha.sendText.mock.calls.at(-1)![2];
    expect(msg).toMatch(/no quedan horarios/i);
  });

  it('nunca crea cita sin confirmación explícita del paciente', async () => {
    // Paciente ya existente con nombre → la FSM salta ASK_NAME.
    prisma.patient.findUnique.mockResolvedValue({
      id: 'pat-1',
      clinicId: 'clinic-A',
      phone: '+584141234567',
      name: 'Ana Existente',
    });

    // Llegamos hasta CONFIRM
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '1',
    });
    // Usuario escribe algo raro en vez de "sí".
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'quizás',
    });

    expect(scheduling.createAppointment).not.toHaveBeenCalled();
    expect(convoState.flowStep).toBe('CONFIRM');
    const msg = waha.sendText.mock.calls.at(-1)![2];
    expect(msg).toMatch(/SÍ|no/i);
  });

  it('si el usuario responde "no" en CONFIRM, no crea cita y resetea', async () => {
    prisma.patient.findUnique.mockResolvedValue({
      id: 'pat-1',
      clinicId: 'clinic-A',
      phone: '+584141234567',
      name: 'Ana Existente',
    });

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '1',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'no',
    });
    expect(scheduling.createAppointment).not.toHaveBeenCalled();
    expect(convoState.flowStep).toBeNull();
  });

  it('lista servicios cuando hay múltiples y respeta la elección por número', async () => {
    const service2 = { ...service1, id: 'svc-2', name: 'Control anual', durationMin: 45 };
    prisma.service.findMany.mockResolvedValue([service1, service2]);
    prisma.service.findFirst.mockImplementation(({ where }: any) => {
      if (where.id === 'svc-1') return Promise.resolve(service1);
      if (where.id === 'svc-2') return Promise.resolve(service2);
      return Promise.resolve(null);
    });

    // Turno 1: pide agendar → ASK_SERVICE (múltiples opciones)
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    expect(convoState.flowStep).toBe('ASK_SERVICE');

    // Turno 2: usuario responde "2"
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '2',
    });
    // Como hay un solo profesional para svc-2, saltamos directo a ASK_SLOT
    expect(convoState.flowStep).toBe('ASK_SLOT');
    expect((convoState.flowData as any).serviceId).toBe('svc-2');
  });

  it('mensaje amable cuando no hay servicios activos', async () => {
    prisma.service.findMany.mockResolvedValue([]);
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    expect(convoState.flowStep).toBeNull();
    const msg = waha.sendText.mock.calls.at(-1)![2];
    expect(msg).toMatch(/no tenemos servicios/i);
  });

  it('mensaje amable cuando no hay slots libres', async () => {
    availability.getSlots.mockResolvedValueOnce([]);
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    expect(convoState.flowStep).toBeNull();
    const msg = waha.sendText.mock.calls.at(-1)![2];
    expect(msg).toMatch(/no encontré horarios/i);
  });

  it('cancelar dentro de la FSM la resetea', async () => {
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    expect(convoState.flowStep).toBe('ASK_SLOT');

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'cancelar',
    });
    expect(convoState.flowStep).toBeNull();
    expect(scheduling.createAppointment).not.toHaveBeenCalled();
  });

  it('si state=HUMAN, el bot no responde', async () => {
    convoState.state = 'HUMAN';
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    expect(waha.sendText).not.toHaveBeenCalled();
  });

  // ─────────────────── Fixes del code-review Bloque 2 ───────────────────

  it('en CONFIRM, "reagendar" re-lista slots sin resetear la FSM', async () => {
    prisma.patient.findUnique.mockResolvedValue({
      id: 'pat-1',
      clinicId: 'clinic-A',
      phone: '+584141234567',
      name: 'Ana Existente',
    });

    // Primera llamada: 1 slot. Segunda llamada (tras "reagendar"): 2 slots nuevos.
    const tomorrow11 = tomorrow10.plus({ hours: 1 });
    const tomorrow1130 = tomorrow11.plus({ minutes: 30 });
    const tomorrow12 = tomorrow10.plus({ hours: 2 });
    const tomorrow1230 = tomorrow12.plus({ minutes: 30 });
    availability.getSlots
      .mockResolvedValueOnce([
        { startAt: tomorrow10.toJSDate(), endAt: tomorrow1030.toJSDate() },
      ])
      .mockResolvedValueOnce([
        { startAt: tomorrow11.toJSDate(), endAt: tomorrow1130.toJSDate() },
        { startAt: tomorrow12.toJSDate(), endAt: tomorrow1230.toJSDate() },
      ]);

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '1',
    });
    expect(convoState.flowStep).toBe('CONFIRM');

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'reagendar',
    });

    // NO se creó cita, NO se reseteó → volvió a ASK_SLOT con lista fresca.
    expect(scheduling.createAppointment).not.toHaveBeenCalled();
    expect(convoState.flowStep).toBe('ASK_SLOT');
    expect((convoState.flowData as any).serviceId).toBe('svc-1');
    expect((convoState.flowData as any).professionalId).toBe('prof-1');
    expect((convoState.flowData as any).offeredSlots).toHaveLength(2);
    expect(availability.getSlots).toHaveBeenCalledTimes(2);
  });

  it('"hablar con una persona" en cualquier paso marca NEEDS_HUMAN y resetea la FSM', async () => {
    // Arrancamos la FSM: quedamos en ASK_SLOT.
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    expect(convoState.flowStep).toBe('ASK_SLOT');
    // Reseteamos el contador del LLM antes del segundo mensaje para verificar
    // que el escape corta antes de detección de intención.
    intent.detect.mockClear();

    // Escape universal desde el medio de la FSM.
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'quiero hablar con una persona',
    });

    expect(convoState.state).toBe('NEEDS_HUMAN');
    expect(convoState.flowStep).toBeNull();
    const msg = waha.sendText.mock.calls.at(-1)![2];
    expect(msg).toMatch(/persona del equipo/i);
    // El LLM NO debe haberse invocado en el segundo turno — el escape corta antes.
    expect(intent.detect).not.toHaveBeenCalled();
  });

  it('slot caducado (BadRequest "pasado") re-ofrece horarios con mensaje específico', async () => {
    prisma.patient.findUnique.mockResolvedValue({
      id: 'pat-1',
      clinicId: 'clinic-A',
      phone: '+584141234567',
      name: 'Ana Existente',
    });

    scheduling.createAppointment.mockRejectedValueOnce(
      new BadRequestException('no se pueden agendar horarios pasados'),
    );

    const tomorrow11 = tomorrow10.plus({ hours: 1 });
    const tomorrow1130 = tomorrow11.plus({ minutes: 30 });
    availability.getSlots
      .mockResolvedValueOnce([
        { startAt: tomorrow10.toJSDate(), endAt: tomorrow1030.toJSDate() },
      ])
      .mockResolvedValueOnce([
        { startAt: tomorrow11.toJSDate(), endAt: tomorrow1130.toJSDate() },
      ]);

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'agendar',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '1',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'sí',
    });

    expect(convoState.flowStep).toBe('ASK_SLOT');
    const msg = waha.sendText.mock.calls.at(-1)![2];
    expect(msg).toMatch(/ya pasó/i);
    expect(msg).not.toMatch(/se me complicó/i);
    expect((convoState.flowData as any).offeredSlots).toHaveLength(1);
  });

  // ─────────────────── RAG FAQ (Intent.PREGUNTA_FAQ) ───────────────────

  it('Intent.PREGUNTA_FAQ con answer=texto: el bot responde con el texto del LLM', async () => {
    intent.detect.mockResolvedValue(Intent.PREGUNTA_FAQ);
    knowledge.answer.mockResolvedValue({
      answer: 'Nuestro horario es de lunes a viernes de 9 a 18h.',
      sources: ['faq-1'],
    });

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '¿Cuáles son los horarios?',
    });

    expect(knowledge.answer).toHaveBeenCalledTimes(1);
    const call = knowledge.answer.mock.calls[0][0];
    expect(call.clinicId).toBe('clinic-A');
    expect(call.question).toBe('¿Cuáles son los horarios?');
    expect(call.locale).toBe('es');
    // La respuesta del LLM llega al paciente.
    const msg = waha.sendText.mock.calls.at(-1)![2];
    expect(msg).toMatch(/lunes a viernes/);
    // NO cambia el estado de la conversación (sigue en BOT).
    expect(convoState.state).toBe('BOT');
  });

  it('Intent.PREGUNTA_FAQ con answer=null: handoff a NEEDS_HUMAN', async () => {
    intent.detect.mockResolvedValue(Intent.PREGUNTA_FAQ);
    knowledge.answer.mockResolvedValue(null);

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '¿Aceptan cripto?',
    });

    // Handoff: conversation → NEEDS_HUMAN + mensaje al paciente.
    // El mensaje concreto es customizable per-tenant (clinic.botHandoffMsg,
    // ver /panel/ajustes). Verificamos el default hardcodeado — "persona del
    // equipo" es el fragmento estable en `BotService.DEFAULT_BOT_MESSAGES`.
    expect(convoState.state).toBe('NEEDS_HUMAN');
    const msg = waha.sendText.mock.calls.at(-1)![2];
    expect(msg).toMatch(/persona del equipo/i);
  });

  // ─────────────────── Rate-limit por chatId (ADR 0007) ───────────────────

  it('el 16to mensaje del mismo chat en la ventana se descarta silenciosamente', async () => {
    intent.detect.mockResolvedValue(Intent.OTRO);

    // Los primeros 15 pasan.
    for (let i = 0; i < 15; i++) {
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: convoState.chatId,
        phone: convoState.phone,
        text: 'ping',
      });
    }
    expect(intent.detect).toHaveBeenCalledTimes(15);
    const callsBefore = waha.sendText.mock.calls.length;

    // El 16to debe cortarse ANTES de intent.detect: sin nuevas llamadas al LLM,
    // sin nuevas respuestas al chat.
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'ping-16',
    });
    expect(intent.detect).toHaveBeenCalledTimes(15);
    expect(waha.sendText.mock.calls.length).toBe(callsBefore);

    // El contador Redis reflejó el intento (INCR corre siempre).
    const rlKeys = [...redisCounters.keys()].filter((k) =>
      k.startsWith('bot:msg:clinic-A:5804141234567@c.us:'),
    );
    expect(rlKeys.length).toBeGreaterThan(0);
    expect(redisCounters.get(rlKeys[0])).toBe(16);
  });

  it('si Redis falla, fail-open: el bot sigue procesando', async () => {
    intent.detect.mockResolvedValue(Intent.OTRO);
    redis.incr.mockRejectedValueOnce(new Error('redis down'));

    // Texto que NO es saludo — GREETING_REGEX cortaría antes de llegar a
    // intent.detect y este test verifica que el pipeline LLM se ejecuta.
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: '¿tienen turno mañana?',
    });

    // Fail-open: intent.detect se llamó igual.
    expect(intent.detect).toHaveBeenCalledTimes(1);
  });

  it('resolveChoice ignora matches por nombre con menos de 3 chars', () => {
    // Accedemos al método privado a propósito: es determinista y no depende de
    // dependencias inyectadas.
    const choices = [
      { id: 'svc-a', label: 'Ana consulta' },
      { id: 'svc-b', label: 'Bruno control' },
    ];
    // "a" solo NO debe resolver a "Ana consulta".
    const resolved = (bot as any).resolveChoice(choices, 'a');
    expect(resolved).toBeNull();
    // Con >= 3 chars sí resuelve por nombre.
    const resolved2 = (bot as any).resolveChoice(choices, 'ana');
    expect(resolved2).not.toBeNull();
    expect(resolved2.id).toBe('svc-a');
    // Un número siempre resuelve por índice, sin importar largo.
    const resolved3 = (bot as any).resolveChoice(choices, '2');
    expect(resolved3.id).toBe('svc-b');
  });

  // ─────────────────── Bot messages: custom + placeholders ───────────────────

  describe('resolveBotMessage (settings de /panel/ajustes)', () => {
    it('sin custom → devuelve el DEFAULT_BOT_MESSAGES de la key', () => {
      const clinic = makeClinic({
        botGreeting: null,
        botFallback: null,
        botHandoffMsg: null,
      });
      expect((bot as any).resolveBotMessage(clinic, 'handoff')).toContain(
        'persona del equipo',
      );
      expect((bot as any).resolveBotMessage(clinic, 'fallback')).toContain(
        'agendar',
      );
    });

    it('custom no vacío → pisa al default', () => {
      const clinic = makeClinic({
        botHandoffMsg: 'Ya te llamamos.',
      });
      expect((bot as any).resolveBotMessage(clinic, 'handoff')).toBe(
        'Ya te llamamos.',
      );
    });

    it('reemplaza {clinicName}', () => {
      const clinic = makeClinic({
        name: 'Mi Consultorio',
        botGreeting: 'Hola, sos parte de {clinicName}',
      });
      expect((bot as any).resolveBotMessage(clinic, 'greeting')).toBe(
        'Hola, sos parte de Mi Consultorio',
      );
    });

    it('reemplaza {patientName} cuando viene, o "" cuando no', () => {
      const clinic = makeClinic({
        botFallback: 'Hola {patientName}, ¿en qué te ayudo?',
      });
      expect(
        (bot as any).resolveBotMessage(clinic, 'fallback', {
          patientName: 'Ana',
        }),
      ).toBe('Hola Ana, ¿en qué te ayudo?');
      expect((bot as any).resolveBotMessage(clinic, 'fallback')).toBe(
        'Hola , ¿en qué te ayudo?',
      );
    });

    it('greeting: "hola" dispara greeting y NO llega al LLM', async () => {
      intent.detect.mockClear();
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: '5804141234567@c.us',
        phone: '+5804141234567',
        text: 'hola',
      });
      const msg = waha.sendText.mock.calls.at(-1)![2];
      expect(msg).toContain('Clínica A'); // {clinicName} en el default
      expect(intent.detect).not.toHaveBeenCalled();
    });
  });
});
