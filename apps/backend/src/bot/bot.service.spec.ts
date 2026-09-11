import { BadRequestException, ConflictException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { FollowUpsService } from '../follow-ups/follow-ups.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { RemindersService } from '../reminders/reminders.service';
import { AvailabilityService } from '../scheduling/availability.service';
import { SchedulingSessionService } from '../scheduling/scheduling-session.service';
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
  let schedulingSessions: Deep<SchedulingSessionService>;
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

    // Pool de variantes en `DEFAULT_BOT_MESSAGES`: forzamos `pickVariant` a
    // devolver la PRIMERA variante. Así los asserts históricos que buscan
    // tokens ("persona del equipo", etc.) siguen matcheando sin tener que
    // enumerar todas las variantes.
    //
    // OJO: NO mockear `Math.random` para esto. `source-map@0.6.1` (ts-jest lo
    // usa para mapear los stack traces) elige el pivote de su quicksort con
    // `Math.random()`; con un valor fijo el quicksort degenera a recursión
    // lineal y el PRIMER test que falla revienta el stack —  jest reporta un
    // "RangeError: Maximum call stack size exceeded / Test suite failed to
    // run" opaco en vez del fallo real. Ver
    // docs/notas/2026-09-11-source-map-stack-overflow.md.
    jest
      .spyOn(BotService.prototype as any, 'pickVariant')
      .mockImplementation((variants: any) => variants[0]);

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
        // Último mensaje OUT de la conversación: si pidió "*SÍ*", un "sí"
        // suelto sí es una confirmación (ver hasConfirmationContext).
        findFirst: jest.fn().mockResolvedValue(null),
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
      // Recordatorio SENT reciente: gatea el "sí" suelto (B2). Default null
      // = no hay nada que confirmar.
      reminder: { findFirst: jest.fn().mockResolvedValue(null) },
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
    // Default: create devuelve un token predecible para asserts de URL.
    // Tests que ejerciten un flujo distinto pueden sobrescribir.
    schedulingSessions = {
      create: jest
        .fn()
        .mockResolvedValue({ token: 'tok-abc', expiresInSeconds: 1800 }),
      resolve: jest.fn().mockResolvedValue(null),
      consume: jest.fn().mockResolvedValue(null),
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
      schedulingSessions as unknown as SchedulingSessionService,
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

  // ── M6: cierre con acción tras responder una duda ──
  describe('cierre con acción tras el RAG (M6)', () => {
    beforeEach(() => {
      intent.detect.mockResolvedValue(Intent.PREGUNTA_FAQ);
      knowledge.answer.mockResolvedValue({
        answer: 'Abrimos de lunes a viernes de 9 a 18h.',
        sources: ['faq-1'],
      });
    });

    async function ask() {
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: convoState.chatId,
        phone: convoState.phone,
        text: '¿cuál es el horario?',
      });
      return waha.sendText.mock.calls.at(-1)![2] as string;
    }

    it('sin cita próxima: anexa la invitación a agendar con el link sin token', async () => {
      prisma.patient.findUnique.mockResolvedValue(null);

      const msg = await ask();

      expect(msg).toContain('Abrimos de lunes a viernes');
      expect(msg).toMatch(/\*agendar\*/);
      expect(msg).toContain('/es/agendar/clinica-a');
      expect(msg).not.toContain('?t='); // link público, no tokenizado
    });

    it('con cita próxima: responde la duda y NO invita a agendar otra', async () => {
      prisma.patient.findUnique.mockResolvedValue({
        id: 'pat-1',
        clinicId: 'clinic-A',
        phone: convoState.phone,
        name: 'Ana',
      });
      prisma.appointment.findFirst.mockResolvedValue({
        id: 'appt-7',
        clinicId: 'clinic-A',
        patientId: 'pat-1',
        status: 'PENDIENTE',
        startAt: tomorrow10.toJSDate(),
      });

      const msg = await ask();

      expect(msg).toBe('Abrimos de lunes a viernes de 9 a 18h.');
      expect(msg).not.toContain('/agendar/');
    });

    it('no repite el link si el mensaje anterior del bot ya lo llevaba', async () => {
      prisma.patient.findUnique.mockResolvedValue(null);
      prisma.message.findFirst.mockResolvedValue({
        body: 'Reserva en línea: http://localhost:3000/es/agendar/clinica-a',
      });

      const msg = await ask();

      expect(msg).toBe('Abrimos de lunes a viernes de 9 a 18h.');
    });

    it('chat @lid sin teléfono: invita igual (no puede tener cita resoluble por phone)', async () => {
      convoState.phone = null;

      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: 'abc123@lid',
        phone: null,
        lid: 'abc123',
        text: '¿cuál es el horario?',
      });

      expect(prisma.appointment.findFirst).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/\*agendar\*/);
    });

    it('el handoff (answer=null) no lleva cierre con acción', async () => {
      knowledge.answer.mockResolvedValue(null);
      prisma.patient.findUnique.mockResolvedValue(null);

      const msg = await ask();

      expect(msg).toMatch(/persona del equipo/i);
      expect(msg).not.toContain('/agendar/');
    });
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
      expect((bot as any).resolveBotMessage(clinic, 'greeting')).toMatch(
        /^Hola, sos parte de Mi Consultorio/,
      );
    });

    it('greeting: agrega SIEMPRE el aviso de asistente automático (ADR 0004 §7.1), también con custom', () => {
      const custom = makeClinic({ botGreeting: 'Hola, soy {clinicName}' });
      const fromCustom = (bot as any).resolveBotMessage(custom, 'greeting');
      expect(fromCustom).toContain(BotService.AI_DISCLOSURE);
      expect(fromCustom).not.toContain('DeepSeek'); // proveedores solo en el consent del form (ADR 0004 §7.1)
      expect(fromCustom).toContain('*humano*');

      const fromDefault = (bot as any).resolveBotMessage(
        makeClinic({ botGreeting: null }),
        'greeting',
      );
      expect(fromDefault).toContain(BotService.AI_DISCLOSURE);

      // fallback/handoff NO llevan el aviso (sólo el primer contacto).
      expect(
        (bot as any).resolveBotMessage(makeClinic(), 'fallback'),
      ).not.toContain(BotService.AI_DISCLOSURE);
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
      expect(msg).toContain('asistente automático'); // aviso ADR 0004 §7.1
      expect(intent.detect).not.toHaveBeenCalled();
    });

    it('greeting: incluye el link público de agendamiento sin token', async () => {
      const prev = process.env.WEB_BASE_URL;
      process.env.WEB_BASE_URL = 'https://showly.us/';
      try {
        await bot.handleIncoming({
          clinicId: 'clinic-A',
          chatId: '5804141234567@c.us',
          phone: '+5804141234567',
          text: 'buenas',
        });
        const msg = waha.sendText.mock.calls.at(-1)![2];
        expect(msg).toContain('https://showly.us/es/agendar/clinica-a');
        expect(msg).not.toContain('?t=');
        expect(msg).toContain('*agendar*');
      } finally {
        if (prev === undefined) delete process.env.WEB_BASE_URL;
        else process.env.WEB_BASE_URL = prev;
      }
    });

    it('greeting con cita próxima: ofrece confirmar/reagendar/cancelar en vez del menú', async () => {
      prisma.patient.findUnique.mockResolvedValue({
        id: 'pat-1',
        clinicId: 'clinic-A',
        phone: '+5804141234567',
        name: 'Ana',
      });
      prisma.appointment.findFirst.mockResolvedValue({
        id: 'appt-1',
        status: 'PENDIENTE',
        startAt: new Date('2026-09-12T14:00:00.000Z'),
        service: { name: 'Limpieza dental' },
        patient: { name: 'Ana' },
      });
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: '5804141234567@c.us',
        phone: '+5804141234567',
        text: 'hola',
      });
      const msg = waha.sendText.mock.calls.at(-1)![2];
      expect(msg).toMatch(/^Hola Ana\./);
      expect(msg).toContain('Limpieza dental');
      expect(msg).toMatch(/\*SÍ\*/);
      expect(msg).toMatch(/\*REAGENDAR\*/);
      expect(msg).toContain('asistente automático');
      expect(msg).not.toContain('/agendar/');
      expect(intent.detect).not.toHaveBeenCalled();
    });

    it('greeting con cita CONFIRMADA: lo dice y no vuelve a pedir confirmación como novedad', async () => {
      prisma.patient.findUnique.mockResolvedValue({ id: 'pat-1', clinicId: 'clinic-A', phone: '+5804141234567', name: null });
      prisma.appointment.findFirst.mockResolvedValue({
        id: 'appt-1',
        status: 'CONFIRMADA',
        startAt: new Date('2026-09-12T14:00:00.000Z'),
        service: { name: 'Limpieza dental' },
        patient: { name: null },
      });
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: '5804141234567@c.us',
        phone: '+5804141234567',
        text: 'hola',
      });
      const msg = waha.sendText.mock.calls.at(-1)![2];
      expect(msg).toMatch(/^Hola\. Tu cita de Limpieza dental .* ya está confirmada/);
    });
  });

  describe('buildSchedulingLink (escalation a form web)', () => {
    beforeEach(() => {
      process.env.WEB_BASE_URL = 'https://showly.us';
    });

    it('genera token via SchedulingSessionService y arma la URL con locale + slug + ?t=', async () => {
      const url = await bot.buildSchedulingLink(
        {
          id: 'convo-1',
          phone: '+584141234567',
          lid: null,
          contactName: 'Ana',
        } as any,
        { id: 'clinic-A', slug: 'clinica-a', locale: 'es' } as any,
      );

      expect(schedulingSessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'convo-1',
          clinicId: 'clinic-A',
          clinicSlug: 'clinica-a',
          phone: '+584141234567',
          name: 'Ana',
        }),
      );
      expect(url).toBe('https://showly.us/es/agendar/clinica-a?t=tok-abc');
    });

    it('normaliza WEB_BASE_URL con trailing slash', async () => {
      process.env.WEB_BASE_URL = 'https://showly.us///';
      const url = await bot.buildSchedulingLink(
        { id: 'c', phone: null, lid: 'xyz', contactName: null } as any,
        { id: 'clinic-A', slug: 'clinica-a', locale: 'pt' } as any,
      );
      expect(url).toBe('https://showly.us/pt/agendar/clinica-a?t=tok-abc');
    });

    it('propaga phone=null y lid al service (caso @lid)', async () => {
      await bot.buildSchedulingLink(
        { id: 'c', phone: null, lid: 'xyz', contactName: null } as any,
        { id: 'clinic-A', slug: 'clinica-a', locale: 'es' } as any,
      );
      expect(schedulingSessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ phone: null, lid: 'xyz', name: null }),
      );
    });
  });

  // ───────────── Respuestas deterministas al recordatorio (SPEC §Recordatorios) ─────────────
  // SÍ / CANCELAR / REAGENDAR se resuelven SIN LLM y fuera de la FSM.
  describe('respuesta del paciente al recordatorio (sin FSM activa)', () => {
    const patient = {
      id: 'pat-1',
      clinicId: 'clinic-A',
      phone: '+584141234567',
      name: 'Ana',
    };
    const upcoming = {
      id: 'appt-7',
      clinicId: 'clinic-A',
      patientId: 'pat-1',
      status: 'PENDIENTE',
      startAt: tomorrow10.toJSDate(),
      endAt: tomorrow1030.toJSDate(),
    };

    beforeEach(() => {
      prisma.patient.findUnique.mockResolvedValue(patient);
      prisma.appointment.findFirst.mockResolvedValue(upcoming);
      prisma.appointment.update = jest.fn().mockResolvedValue({ ...upcoming, status: 'CANCELADA' });
      reminders.confirmAppointment.mockResolvedValue(undefined);
      reminders.cancelForAppointment.mockResolvedValue(undefined);
      // Hay un recordatorio ya enviado: el "sí" suelto SÍ es una respuesta a
      // ese recordatorio (B2). Los tests que prueban lo contrario lo pisan.
      prisma.reminder.findFirst.mockResolvedValue({ id: 'rem-1' });
    });

    async function say(text: string) {
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: convoState.chatId,
        phone: convoState.phone,
        text,
      });
    }

    it('busca la próxima cita dentro del tenant (clinicId + patientId, estados abiertos, futura)', async () => {
      await say('sí');

      expect(prisma.patient.findUnique).toHaveBeenCalledWith({
        where: { clinicId_phone: { clinicId: 'clinic-A', phone: '+584141234567' } },
      });
      const where = prisma.appointment.findFirst.mock.calls[0][0].where;
      expect(where.clinicId).toBe('clinic-A');
      expect(where.patientId).toBe('pat-1');
      expect(where.status).toEqual({ in: ['PENDIENTE', 'EN_RIESGO', 'CONFIRMADA'] });
      expect(where.startAt.gte).toBeInstanceOf(Date);
    });

    it.each(['sí', 'SI', 'Confirmo', 'ok', 'dale'])(
      '"%s" → confirma la cita vía RemindersService y no invoca al LLM',
      async (text) => {
        await say(text);

        expect(reminders.confirmAppointment).toHaveBeenCalledWith('appt-7');
        expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
        expect(intent.detect).not.toHaveBeenCalled();
        expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/confirmada/i);
      },
    );

    it.each(['cancelar', 'CANCELAR', 'cancelo', 'anular'])(
      '"%s" → marca la cita CANCELADA con canceledAt y elimina sus recordatorios',
      async (text) => {
        await say(text);

        expect(prisma.appointment.update).toHaveBeenCalledWith({
          where: { id: 'appt-7' },
          data: expect.objectContaining({ status: 'CANCELADA', canceledAt: expect.any(Date) }),
        });
        expect(reminders.cancelForAppointment).toHaveBeenCalledWith('appt-7');
        expect(reminders.confirmAppointment).not.toHaveBeenCalled();
        expect(intent.detect).not.toHaveBeenCalled();
        expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/cancelada/i);
      },
    );

    it.each(['reagendar', 'reprogramar'])(
      '"%s" → detiene los recordatorios, deriva a recepción (NEEDS_HUMAN) y NO mueve la cita',
      async (text) => {
        await say(text);

        expect(reminders.cancelForAppointment).toHaveBeenCalledWith('appt-7');
        expect(prisma.appointment.update).not.toHaveBeenCalled();
        expect(convoState.state).toBe('NEEDS_HUMAN');
        expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/recepción/i);
      },
    );

    it('Intent.REPROGRAMAR del LLM sigue el mismo camino que "reagendar"', async () => {
      intent.detect.mockResolvedValue(Intent.REPROGRAMAR);

      await say('quiero mover mi turno de la semana que viene');

      expect(reminders.cancelForAppointment).toHaveBeenCalledWith('appt-7');
      expect(convoState.state).toBe('NEEDS_HUMAN');
    });

    it('sin cita próxima: responde que no la encontró y no toca reminders', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);

      await say('sí');

      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
      expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/No encontré una cita/i);
    });

    it('paciente desconocido en este tenant: no cruza a otras clínicas', async () => {
      prisma.patient.findUnique.mockResolvedValue(null);

      await say('cancelar');

      expect(prisma.appointment.findFirst).not.toHaveBeenCalled();
      expect(prisma.appointment.update).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/No encontré una cita/i);
    });

    it('chat @lid sin teléfono: no puede asociar cita → deriva a recepción', async () => {
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: 'abc123@lid',
        phone: null,
        lid: 'abc123',
        text: 'sí',
      });

      expect(prisma.appointment.findFirst).not.toHaveBeenCalled();
      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
      expect(convoState.state).toBe('NEEDS_HUMAN');
    });

    it('"sí" con la FSM activa NO se interpreta como confirmación de recordatorio', async () => {
      convoState.flowStep = 'ASK_NAME';
      convoState.flowData = { serviceId: 'svc-1', professionalId: 'prof-1', startAtISO: tomorrow10.toISO() };

      await say('sí');

      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
    });

    it('"sin turno para hoy?" no matchea el prefijo "si" (word boundary)', async () => {
      intent.detect.mockResolvedValue(Intent.PREGUNTA_FAQ);

      await say('sin turno para hoy?');

      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
      expect(intent.detect).toHaveBeenCalledTimes(1);
    });

    // ── B2: "sí/ok/dale" solo confirman cuando hay un recordatorio esperando ──

    it('busca el recordatorio SENT dentro del tenant y de la ventana de 48 h', async () => {
      await say('sí');

      const where = prisma.reminder.findFirst.mock.calls[0][0].where;
      expect(where.status).toBe('SENT');
      expect(where.sentAt.gte).toBeInstanceOf(Date);
      expect(Date.now() - where.sentAt.gte.getTime()).toBeCloseTo(
        48 * 3600 * 1000,
        -4,
      );
      expect(where.appointment.clinicId).toBe('clinic-A');
      expect(where.appointment.patient).toEqual({
        clinicId: 'clinic-A',
        phone: '+584141234567',
      });
    });

    it('"sí" suelto SIN contexto de confirmación: responde el menú, no "no encontré cita"', async () => {
      prisma.reminder.findFirst.mockResolvedValue(null);

      await say('sí');

      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
      expect(prisma.appointment.findFirst).not.toHaveBeenCalled();
      expect(intent.detect).not.toHaveBeenCalled();
      const msg = waha.sendText.mock.calls.at(-1)![2];
      expect(msg).not.toMatch(/No encontré una cita/i);
      expect(msg).toMatch(/\*agendar\*/);
    });

    it('"sí, quiero agendar una cita" NO confirma: va al clasificador y arranca la FSM', async () => {
      intent.detect.mockResolvedValue(Intent.AGENDAR);

      await say('sí, quiero agendar una cita');

      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
      expect(prisma.reminder.findFirst).not.toHaveBeenCalled();
      expect(intent.detect).toHaveBeenCalledWith(
        'sí, quiero agendar una cita',
        'es',
      );
      // Con 1 servicio y 1 profesional en el mock, startFlow salta directo a
      // ASK_SLOT: lo que importa es que la FSM arrancó.
      expect(convoState.flowStep).toMatch(/^ASK_/);
    });

    it('"ok gracias" cierra con cortesía: sin LLM, sin recordatorios, sin "no encontré cita"', async () => {
      await say('ok gracias');

      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
      expect(prisma.reminder.findFirst).not.toHaveBeenCalled();
      expect(intent.detect).not.toHaveBeenCalled();
      const msg = waha.sendText.mock.calls.at(-1)![2];
      expect(msg).toMatch(/Con gusto/i);
      expect(msg).not.toMatch(/No encontré una cita/i);
    });

    it('"gracias, quiero agendar" NO es un cierre: sigue al clasificador', async () => {
      intent.detect.mockResolvedValue(Intent.AGENDAR);

      await say('gracias, quiero agendar');

      expect(waha.sendText.mock.calls.at(-1)![2]).not.toMatch(/Con gusto/i);
      expect(intent.detect).toHaveBeenCalledTimes(1);
    });

    it('"confirmo" es un verbo explícito: confirma aunque no haya recordatorio', async () => {
      prisma.reminder.findFirst.mockResolvedValue(null);

      await say('confirmo');

      expect(reminders.confirmAppointment).toHaveBeenCalledWith('appt-7');
      expect(intent.detect).not.toHaveBeenCalled();
    });

    it('un Reminder SENT de OTRA clínica no habilita el "sí" (aislamiento efectivo)', async () => {
      // El mock devuelve null para el where con clinicId='clinic-A': simula que
      // el único recordatorio SENT del sistema es de otro tenant.
      prisma.reminder.findFirst.mockImplementation(async ({ where }: any) =>
        where.appointment.clinicId === 'clinic-A' ? null : { id: 'rem-otra' },
      );

      await say('sí');

      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/\*agendar\*/);
    });

    // ── C1: el bot pide "responde *SÍ*" sin crear ningún Reminder ──

    it('si el último mensaje del bot pidió "*SÍ*", un "sí" suelto confirma sin Reminder', async () => {
      prisma.reminder.findFirst.mockResolvedValue(null);
      prisma.message.findFirst.mockResolvedValue({
        body: 'Veo que tienes una cita mañana. Responde *SÍ* para confirmarla.',
      });

      await say('sí');

      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversationId: 'convo-1', direction: 'OUT' },
        }),
      );
      expect(reminders.confirmAppointment).toHaveBeenCalledWith('appt-7');
      expect(intent.detect).not.toHaveBeenCalled();
    });

    it('saludo con cita próxima → "sí" confirma (no cae en el fallback)', async () => {
      prisma.reminder.findFirst.mockResolvedValue(null);
      prisma.patient.findUnique.mockResolvedValue(patient);
      prisma.appointment.findFirst.mockResolvedValue({
        ...upcoming,
        service: { name: 'Limpieza dental' },
        patient: { name: 'Ana' },
      });
      // Turno 1: "hola" → el bot ofrece confirmar con *SÍ*.
      await say('hola');
      const greeting = waha.sendText.mock.calls.at(-1)![2];
      expect(greeting).toMatch(/\*SÍ\*/);
      // El mock de message.create no persiste: simulamos ese OUT.
      prisma.message.findFirst.mockResolvedValue({ body: greeting });

      // Turno 2: el paciente responde lo que el bot le pidió.
      await say('sí');

      expect(reminders.confirmAppointment).toHaveBeenCalledWith('appt-7');
    });

    // ── O1: confirmaciones de más de 2 palabras ──

    it.each(['sí por favor', 'sí, ahí estaré', 'sí, confirmo mi cita'])(
      '"%s" con recordatorio SENT confirma sin pasar por el LLM',
      async (text) => {
        await say(text);

        expect(reminders.confirmAppointment).toHaveBeenCalledWith('appt-7');
        expect(intent.detect).not.toHaveBeenCalled();
      },
    );

    it('"sí, cuánto cuesta la limpieza?" no confirma: nombra otra cosa', async () => {
      intent.detect.mockResolvedValue(Intent.PREGUNTA_FAQ);
      knowledge.answer.mockResolvedValue({ answer: 'Cuesta 30 USD.' });

      await say('sí, cuánto cuesta la limpieza?');

      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
      expect(intent.detect).toHaveBeenCalledTimes(1);
    });
  });

  // ── B1: el saludo se recorta, no se come el resto del mensaje ──
  describe('saludo con contenido (B1)', () => {
    async function say(text: string) {
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: convoState.chatId,
        phone: convoState.phone,
        text,
      });
    }

    it('"hola que tal" es solo saludo: responde el greeting y no toca el LLM', async () => {
      await say('hola que tal');

      expect(intent.detect).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toContain(
        'asistente automático',
      );
    });

    it('"hola, quiero agendar una cita" arranca la FSM sin saludar antes', async () => {
      intent.detect.mockResolvedValue(Intent.AGENDAR);

      await say('hola, quiero agendar una cita');

      // El saludo se recorta: al clasificador va solo el pedido real.
      expect(intent.detect).toHaveBeenCalledWith('quiero agendar una cita', 'es');
      // Con 1 servicio y 1 profesional en el mock, startFlow salta directo a
      // ASK_SLOT: lo que importa es que la FSM arrancó.
      expect(convoState.flowStep).toMatch(/^ASK_/);
      const sent = waha.sendText.mock.calls.map((c: any[]) => c[2]).join('\n');
      expect(sent).not.toContain('asistente automático');
    });

    it('"buenas, cuánto cuesta la limpieza?" va al RAG con la pregunta recortada', async () => {
      intent.detect.mockResolvedValue(Intent.PREGUNTA_FAQ);
      knowledge.answer.mockResolvedValue({ answer: 'La limpieza cuesta 30 USD.' });

      await say('buenas, cuánto cuesta la limpieza?');

      expect(knowledge.answer).toHaveBeenCalledWith(
        expect.objectContaining({ question: 'cuánto cuesta la limpieza?' }),
      );
      expect(waha.sendText.mock.calls.at(-1)![2]).toContain('30 USD');
    });

    it('también recorta "buenos días" y el nombre de la clínica', async () => {
      intent.detect.mockResolvedValue(Intent.PREGUNTA_FAQ);
      knowledge.answer.mockResolvedValue({ answer: 'Estamos en Av. Siempre Viva 123.' });

      await say('Buenos días Clínica A, dónde quedan ustedes?');

      expect(knowledge.answer).toHaveBeenCalledWith(
        expect.objectContaining({ question: 'dónde quedan ustedes?' }),
      );
    });

    it.each([
      'hola quiero agendar',
      'hola necesito cita',
      'buenas, horarios',
      'hola atienden hoy',
    ])('"%s" (fraseo corto) NO se responde como saludo', async (text) => {
      intent.detect.mockResolvedValue(Intent.PREGUNTA_FAQ);
      knowledge.answer.mockResolvedValue({ answer: 'Sí, atendemos.' });

      await say(text);

      expect(intent.detect).toHaveBeenCalledTimes(1);
      const sent = waha.sendText.mock.calls.map((c: any[]) => c[2]).join('\n');
      expect(sent).not.toContain('asistente automático');
    });

    it('con la FSM activa el saludo no se recorta: "hola" es la respuesta al paso', async () => {
      convoState.flowStep = 'ASK_NAME';
      convoState.flowData = {
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO: tomorrow10.toISO(),
      };

      await say('hola');

      expect(intent.detect).not.toHaveBeenCalled();
      // Siguió dentro de la FSM (no respondió el greeting con el aviso de IA).
      expect(waha.sendText.mock.calls.at(-1)![2]).not.toContain(
        'asistente automático',
      );
    });

    it('mensaje sin saludo no se toca', async () => {
      intent.detect.mockResolvedValue(Intent.PREGUNTA_FAQ);
      knowledge.answer.mockResolvedValue({ answer: 'Sí.' });

      await say('¿atienden los sábados?');

      expect(intent.detect).toHaveBeenCalledWith('¿atienden los sábados?', 'es');
    });
  });

  // ── B3: "persona" suelta no es un pedido de humano ──
  describe('escape a humano (B3)', () => {
    async function say(text: string) {
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: convoState.chatId,
        phone: convoState.phone,
        text,
      });
    }

    it('"es para otra persona" NO deriva: sigue al clasificador', async () => {
      intent.detect.mockResolvedValue(Intent.AGENDAR);

      await say('es para otra persona');

      expect(convoState.state).toBe('BOT');
      expect(intent.detect).toHaveBeenCalledTimes(1);
      expect(waha.sendText.mock.calls.at(-1)![2]).not.toMatch(
        /persona del equipo/i,
      );
    });

    it('"quiero hablar con una persona" sí deriva', async () => {
      await say('quiero hablar con una persona');

      expect(convoState.state).toBe('NEEDS_HUMAN');
      expect(intent.detect).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/persona del equipo/i);
    });

    it('"humano" sí deriva', async () => {
      await say('humano');

      expect(convoState.state).toBe('NEEDS_HUMAN');
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/persona del equipo/i);
    });

    it('"necesito que me atienda una persona" sí deriva', async () => {
      await say('necesito que me atienda una persona');

      expect(convoState.state).toBe('NEEDS_HUMAN');
    });
  });

  // ───────────── Sub-FSM de satisfacción post-atención (ADR 0012) ─────────────
  describe('sub-FSM AWAITING_NPS_SCORE / AWAITING_NPS_COMMENT', () => {
    beforeEach(() => {
      convoState.flowStep = 'AWAITING_NPS_SCORE';
      convoState.flowData = { feedbackAppointmentId: 'appt-9' };
      (prisma as any).feedback = { update: jest.fn().mockResolvedValue({}) };
    });

    async function say(text: string) {
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: convoState.chatId,
        phone: convoState.phone,
        text,
      });
    }

    it.each([
      ['5', 5],
      ['1', 1],
      ['cinco', 5],
      ['3 estrellas', 3],
    ])('"%s" → registra score %s con clinicId y pasa a AWAITING_NPS_COMMENT', async (text, score) => {
      await say(text);

      expect(followUps.recordFeedback).toHaveBeenCalledWith('clinic-A', 'appt-9', score);
      expect(convoState.flowStep).toBe('AWAITING_NPS_COMMENT');
      expect(convoState.flowData).toEqual({ feedbackAppointmentId: 'appt-9', feedbackScore: score });
      expect(intent.detect).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/Gracias/);
    });

    it.each(['0', '6', '10', 'excelente'])(
      '"%s" fuera de rango → pide corregir y se queda en AWAITING_NPS_SCORE',
      async (text) => {
        await say(text);

        expect(followUps.recordFeedback).not.toHaveBeenCalled();
        expect(convoState.flowStep).toBe('AWAITING_NPS_SCORE');
        expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/número del \*1\* al \*5\*/);
      },
    );

    it('"cancelar" durante el score NO aborta la sub-FSM ni cancela citas', async () => {
      await say('cancelar');

      expect(convoState.flowStep).toBe('AWAITING_NPS_SCORE');
      expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/no te entendí/i);
    });

    it('segunda respuesta (created=false) → agradece y cierra la sub-FSM sin pedir comentario', async () => {
      followUps.recordFeedback.mockResolvedValue({ created: false });

      await say('4');

      expect(convoState.flowStep).toBeNull();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/Gracias por tu respuesta/);
    });

    it('flowData corrupto (sin feedbackAppointmentId) → resetea sin registrar nada', async () => {
      convoState.flowData = {};

      await say('5');

      expect(followUps.recordFeedback).not.toHaveBeenCalled();
      expect(convoState.flowStep).toBeNull();
    });

    it('AWAITING_NPS_COMMENT: texto libre se guarda como comment (máx 1000) y cierra', async () => {
      convoState.flowStep = 'AWAITING_NPS_COMMENT';
      convoState.flowData = { feedbackAppointmentId: 'appt-9', feedbackScore: 5 };
      const long = 'x'.repeat(1500);

      await say(`  ${long}  `);

      expect(prisma.feedback.update).toHaveBeenCalledWith({
        where: { appointmentId: 'appt-9' },
        data: { comment: 'x'.repeat(1000) },
      });
      expect(convoState.flowStep).toBeNull();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/Muchas gracias/);
    });

    it.each(['no', 'Nada', 'listo', 'OK'])(
      'AWAITING_NPS_COMMENT: "%s" cierra sin guardar comentario',
      async (text) => {
        convoState.flowStep = 'AWAITING_NPS_COMMENT';
        convoState.flowData = { feedbackAppointmentId: 'appt-9', feedbackScore: 5 };

        await say(text);

        expect(prisma.feedback.update).not.toHaveBeenCalled();
        expect(convoState.flowStep).toBeNull();
      },
    );
  });
});
