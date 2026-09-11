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
        // S5: liga `patientId`. `updateMany` (no `update`) porque el where
        // lleva `clinicId` además del id.
        updateMany: jest.fn().mockImplementation(async ({ data }: any) => {
          if ('patientId' in data) convoState.patientId = data.patientId;
          return { count: 1 };
        }),
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
      patient: {
        findUnique: jest.fn().mockResolvedValue(null),
        // `linkConversationPatient` comprueba que el paciente sea de la clínica
        // antes de escribir (defensa en profundidad contra un cross-tenant).
        findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
          where.clinicId === 'clinic-A' ? { id: where.id } : null,
        ),
      },
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
        appointment: {
          id: 'appt-new',
          status: 'PENDIENTE',
          startAt: tomorrow10.toJSDate(),
          endAt: tomorrow1030.toJSDate(),
        },
        patientCreated: true,
      }),
    };
    // Default: create devuelve un token predecible para asserts de URL.
    // Tests que ejerciten un flujo distinto pueden sobrescribir.
    schedulingSessions = {
      create: jest
        .fn()
        .mockResolvedValue({ token: 'tok-abc', expiresInSeconds: 1800 }),
      // Link de gestión de una cita concreta (ADR 0020 / M2-c).
      issueManageUrl: jest
        .fn()
        .mockResolvedValue('http://localhost:3000/es/agendar/clinica-a/cita?t=mtok-abc'),
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

  it('S5: confirmar por la FSM deja la conversación ligada al paciente de la cita', async () => {
    scheduling.createAppointment.mockResolvedValue({
      appointment: {
        id: 'appt-new',
        patientId: 'pat-nuevo',
        status: 'PENDIENTE',
        startAt: tomorrow10.toJSDate(),
        endAt: tomorrow1030.toJSDate(),
      },
      patientCreated: true,
    });

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'quiero agendar',
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
      text: 'Ana Pérez',
    });
    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: convoState.chatId,
      phone: convoState.phone,
      text: 'sí',
    });

    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'convo-1', clinicId: 'clinic-A' },
      data: { patientId: 'pat-nuevo' },
    });
    expect(convoState.patientId).toBe('pat-nuevo');
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

  // ── M4: más horarios, cualquier profesional, preferencia y salida al web ──
  describe('navegación de horarios en la FSM (M4)', () => {
    const professional2 = {
      id: 'prof-2',
      clinicId: 'clinic-A',
      name: 'Dr. Salas',
      active: true,
    };
    const zone = 'America/Caracas';

    /** Slot a `days` días vista, a la hora indicada en la TZ de la clínica. */
    function slotAt(days: number, hour: number) {
      const start = DateTime.now()
        .setZone(zone)
        .plus({ days })
        .set({ hour, minute: 0, second: 0, millisecond: 0 });
      return { startAt: start.toJSDate(), endAt: start.plus({ minutes: 30 }).toJSDate() };
    }

    async function say(text: string) {
      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: convoState.chatId,
        phone: convoState.phone,
        text,
      });
      return waha.sendText.mock.calls.at(-1)![2] as string;
    }

    /** Deja la conversación en ASK_SLOT con la lista ya mostrada. */
    async function reachAskSlot() {
      await say('agendar');
      expect(convoState.flowStep).toBe('ASK_SLOT');
    }

    describe('"0. Ver más horarios"', () => {
      it('ofrece la opción y avanza la ventana 7 días', async () => {
        availability.getSlots.mockResolvedValue([slotAt(1, 9), slotAt(2, 15)]);

        const first = await say('agendar');
        expect(first).toContain('0. Ver más horarios');

        availability.getSlots.mockClear();
        availability.getSlots.mockResolvedValue([slotAt(8, 11)]);
        const second = await say('0');

        expect(convoState.flowStep).toBe('ASK_SLOT');
        expect((convoState.flowData as any).slotWindowCount).toBe(1);
        expect(second).toContain('semana siguiente');
        // La ventana arranca ~7 días más adelante.
        const fromISO = availability.getSlots.mock.calls[0][0].fromISO;
        const diffDays = DateTime.fromISO(fromISO).diff(DateTime.now(), 'days').days;
        expect(diffDays).toBeGreaterThan(6.5);
        expect(diffDays).toBeLessThan(7.5);
      });

      it('también entiende "más horarios" en palabras', async () => {
        availability.getSlots.mockResolvedValue([slotAt(1, 9)]);
        await reachAskSlot();

        availability.getSlots.mockClear();
        availability.getSlots.mockResolvedValue([slotAt(8, 9)]);
        await say('más horarios');

        expect(availability.getSlots).toHaveBeenCalledTimes(1);
        expect((convoState.flowData as any).slotWindowCount).toBe(1);
      });

      it('al llegar al tope de 4 ventanas ofrece el link y no consulta más', async () => {
        availability.getSlots.mockResolvedValue([slotAt(1, 9)]);
        await reachAskSlot();
        convoState.flowData = { ...(convoState.flowData as any), slotWindowCount: 3 };

        availability.getSlots.mockClear();
        const msg = await say('0');

        expect(availability.getSlots).not.toHaveBeenCalled();
        expect(msg).toContain('?t=tok-abc');
        // No reseteamos: los horarios ya mostrados siguen siendo elegibles.
        expect(convoState.flowStep).toBe('ASK_SLOT');
      });

      it('sin horarios en una ventana avanzada, ofrece el link sin resetear', async () => {
        availability.getSlots.mockResolvedValue([slotAt(1, 9)]);
        await reachAskSlot();

        availability.getSlots.mockResolvedValue([]);
        const msg = await say('0');

        expect(msg).toContain('?t=tok-abc');
        expect(convoState.flowStep).toBe('ASK_SLOT');
      });
    });

    describe('"Cualquier profesional"', () => {
      beforeEach(() => {
        prisma.professional.findMany.mockResolvedValue([professional1, professional2]);
        prisma.professional.findFirst.mockImplementation(({ where }: any) =>
          Promise.resolve(
            where.id === 'prof-2' ? professional2 : where.id === 'prof-1' ? professional1 : null,
          ),
        );
      });

      it('aparece como última opción cuando hay más de un profesional', async () => {
        const msg = await say('agendar');

        expect(convoState.flowStep).toBe('ASK_PROFESSIONAL');
        expect(msg).toContain('1. Dra. Ríos');
        expect(msg).toContain('2. Dr. Salas');
        expect(msg).toContain('3. Cualquier profesional');
      });

      it('elegirla mezcla los horarios de todos y fija el profesional al elegir el slot', async () => {
        availability.getSlots.mockImplementation(({ professionalId }: any) =>
          Promise.resolve(
            professionalId === 'prof-1' ? [slotAt(2, 14)] : [slotAt(1, 9)],
          ),
        );

        await say('agendar');
        const list = await say('3'); // Cualquier profesional

        expect(convoState.flowStep).toBe('ASK_SLOT');
        expect((convoState.flowData as any).anyProfessional).toBe(true);
        // Ordenados por fecha: primero el de prof-2 (mañana), luego prof-1.
        expect((convoState.flowData as any).offeredProfessionalIds).toEqual([
          'prof-2',
          'prof-1',
        ]);
        expect(list).toContain('1.');

        await say('1');

        expect((convoState.flowData as any).professionalId).toBe('prof-2');
      });

      it('si dos profesionales ofrecen la misma hora, el horario se muestra una vez', async () => {
        const same = slotAt(1, 9);
        availability.getSlots.mockResolvedValue([same]);

        await say('agendar');
        await say('cualquiera');

        expect((convoState.flowData as any).offeredSlots).toHaveLength(1);
        // Se lo queda el primero por orden de nombre (Dra. Ríos).
        expect((convoState.flowData as any).offeredProfessionalIds).toEqual(['prof-1']);
      });
    });

    describe('preferencia de horario en el mismo mensaje', () => {
      beforeEach(() => {
        prisma.professional.findMany.mockResolvedValue([professional1, professional2]);
        prisma.professional.findFirst.mockResolvedValue(professional1);
      });

      it('"1, por la tarde" filtra la lista antes de mostrarla', async () => {
        availability.getSlots.mockResolvedValue([
          slotAt(1, 9),
          slotAt(1, 15),
          slotAt(2, 16),
        ]);

        await say('agendar');
        await say('1, por la tarde');

        const offered = (convoState.flowData as any).offeredSlots as string[];
        expect(offered).toHaveLength(2);
        for (const iso of offered) {
          expect(DateTime.fromISO(iso).setZone(zone).hour).toBeGreaterThanOrEqual(12);
        }
      });

      it('si la preferencia no deja nada, lo dice y muestra la lista completa', async () => {
        availability.getSlots.mockResolvedValue([slotAt(1, 9), slotAt(2, 10)]);

        await say('agendar');
        const msg = await say('1, por la tarde');

        expect(msg).toContain('No me quedan horarios con esa preferencia');
        expect((convoState.flowData as any).offeredSlots).toHaveLength(2);
      });

      it('en ASK_SLOT, un mensaje sin número pero con preferencia re-filtra en vez de "no te entendí"', async () => {
        availability.getSlots.mockResolvedValue([slotAt(1, 9), slotAt(1, 16)]);
        prisma.professional.findMany.mockResolvedValue([professional1]);

        await reachAskSlot();
        const msg = await say('mejor por la tarde');

        expect(msg).not.toContain('no te entendí');
        expect((convoState.flowData as any).offeredSlots).toHaveLength(1);
      });
    });

    describe('salida al form web tras dos respuestas sin entender', () => {
      beforeEach(() => {
        availability.getSlots.mockResolvedValue([slotAt(1, 9)]);
      });

      it('la primera repite la lista; la segunda ofrece el link sin resetear la FSM', async () => {
        await reachAskSlot();

        const first = await say('ehh no sé');
        expect(first).not.toContain('?t=');
        expect((convoState.flowData as any).invalidCount).toBe(1);

        const second = await say('qué opciones hay');
        expect(second).toContain('?t=tok-abc');
        expect(convoState.flowStep).toBe('ASK_SLOT');
        expect((convoState.flowData as any).invalidCount).toBe(2);
      });

      it('una respuesta válida reinicia el contador', async () => {
        prisma.service.findMany.mockResolvedValue([
          service1,
          { ...service1, id: 'svc-2', name: 'Control anual' },
        ]);

        await say('agendar');
        expect(convoState.flowStep).toBe('ASK_SERVICE');

        await say('ninguno de esos');
        expect((convoState.flowData as any).invalidCount).toBe(1);

        await say('1');
        expect(convoState.flowStep).toBe('ASK_SLOT');
        expect((convoState.flowData as any).invalidCount).toBe(0);
      });
    });
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
    // El teléfono de la conversación va al RAG: habilita la parte de "tu
    // próxima cita" del bloque de hechos de BD (ClinicFactsService lo filtra
    // por clinicId + phone).
    expect(call.phone).toBe(convoState.phone);
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

      // S5: sin teléfono todavía se puede resolver por conversationId, pero
      // este chat no tiene ninguna cita, así que la invitación va igual.
      for (const call of prisma.appointment.findFirst.mock.calls) {
        expect(call[0].where.clinicId).toBe('clinic-A');
        expect(call[0].where.patientId).toBeUndefined();
      }
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

  it('Intent.PREGUNTA_FAQ desde un chat @lid: pasa phone=null al RAG, sin romper', async () => {
    convoState.phone = null;
    intent.detect.mockResolvedValue(Intent.PREGUNTA_FAQ);
    knowledge.answer.mockResolvedValue({ answer: 'Abrimos de 9 a 18h.', sources: [] });

    await bot.handleIncoming({
      clinicId: 'clinic-A',
      chatId: 'abc123@lid',
      phone: null,
      lid: 'abc123',
      text: '¿a qué hora abren?',
    });

    expect(knowledge.answer.mock.calls[0][0].phone).toBeNull();
    expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/9 a 18h/);
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

  // El rate-limit del ADR 0007 ya no vive en `handleIncoming`: con la cola
  // `bot-inbound` en medio pasó al webhook, ANTES de encolar. Su cobertura
  // está en `webhook.controller.spec.ts` → "rate-limit antes de encolar".
  // Ver docs/adr/0021-cola-bot-inbound.md.

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

    it('busca la próxima cita dentro del tenant, por conversación y luego por teléfono (S5)', async () => {
      // Sin `patientId` ligado: primero se prueba por conversationId y, si no
      // hay nada, por el teléfono de la conversación.
      prisma.appointment.findFirst
        .mockResolvedValueOnce(null) // por conversationId
        .mockResolvedValue(upcoming); // por patientId tras resolver el phone

      await say('sí');

      const byConversation = prisma.appointment.findFirst.mock.calls[0][0].where;
      expect(byConversation.clinicId).toBe('clinic-A');
      expect(byConversation.conversationId).toBe('convo-1');
      expect(byConversation.status).toEqual({
        in: ['PENDIENTE', 'EN_RIESGO', 'CONFIRMADA'],
      });
      expect(byConversation.startAt.gte).toBeInstanceOf(Date);

      expect(prisma.patient.findUnique).toHaveBeenCalledWith({
        where: { clinicId_phone: { clinicId: 'clinic-A', phone: '+584141234567' } },
      });
      const byPatient = prisma.appointment.findFirst.mock.calls[1][0].where;
      expect(byPatient.clinicId).toBe('clinic-A');
      expect(byPatient.patientId).toBe('pat-1');
    });

    it('ligar `patientId` de paso: al resolver por teléfono, la conversación queda ligada', async () => {
      prisma.appointment.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValue(upcoming);

      await say('sí');

      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: { id: 'convo-1', clinicId: 'clinic-A' },
        data: { patientId: 'pat-1' },
      });
      expect(convoState.patientId).toBe('pat-1');
    });

    it('con `patientId` ya ligado no vuelve a resolver el teléfono', async () => {
      convoState.patientId = 'pat-1';

      await say('sí');

      const where = prisma.appointment.findFirst.mock.calls[0][0].where;
      expect(where.patientId).toBe('pat-1');
      expect(prisma.patient.findUnique).not.toHaveBeenCalled();
      expect(reminders.confirmAppointment).toHaveBeenCalledWith('appt-7');
    });

    it('conversación ligada por `patientId` y sin teléfono: el "sí" confirma igual', async () => {
      // El caso que motivó S5: chat @lid que agendó por la web.
      convoState.patientId = 'pat-1';
      convoState.phone = null;

      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: 'abc123@lid',
        phone: null,
        lid: 'abc123',
        text: 'sí',
      });

      expect(reminders.confirmAppointment).toHaveBeenCalledWith('appt-7');
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
      '"%s" → ofrece horarios por chat con el link como alternativa, sin mover ni apagar nada',
      async (text) => {
        await say(text);

        // M2-c: la cita sigue en pie hasta que el paciente la mueva, así que
        // apagarle los recordatorios la dejaba sin red justo cuando más riesgo
        // de no-show tiene.
        expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
        expect(prisma.appointment.update).not.toHaveBeenCalled();
        expect(convoState.state).toBe('BOT');

        // B5: la FSM queda lista para elegir horario, con la cita a mover.
        expect(convoState.flowStep).toBe('ASK_SLOT');
        expect((convoState.flowData as any).rescheduleOf).toBe('appt-7');
        const msg = waha.sendText.mock.calls.at(-1)![2];
        expect(msg).toContain('sigue en pie');
        expect(msg).toContain('/cita?t=');
      },
    );

    it('reagendar usa el MISMO servicio y profesional de la cita', async () => {
      await say('reagendar');

      const call = availability.getSlots.mock.calls.at(-1)![0];
      expect(call.serviceId).toBe('svc-1');
      expect(call.professionalId).toBe('prof-1');
      expect((convoState.flowData as any).serviceId).toBe('svc-1');
      expect((convoState.flowData as any).professionalId).toBe('prof-1');
    });

    it('elegir el horario MUEVE la cita in-place: mismo id, sin crear otra', async () => {
      scheduling.rescheduleAppointment = jest.fn().mockResolvedValue({
        id: 'appt-7',
        status: 'PENDIENTE',
        patientId: 'pat-1',
        startAt: tomorrow10.toJSDate(),
        endAt: tomorrow1030.toJSDate(),
      });
      prisma.patient.findUnique.mockResolvedValue({ ...patient, name: 'Ana' });

      await say('reagendar');
      await say('1');

      expect(convoState.flowStep).toBe('CONFIRM');

      await say('sí');

      expect(scheduling.rescheduleAppointment).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId: 'clinic-A',
          appointmentId: 'appt-7',
          byPatient: true,
          maxPatientReschedules: 3,
        }),
      );
      // Nunca se crea una cita nueva: eso inflaría CANCELADA y diluiría el
      // no-show rate.
      expect(scheduling.createAppointment).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toContain('movida');
    });

    it('si no se puede emitir el link, reagendar sigue derivando a recepción', async () => {
      schedulingSessions.issueManageUrl.mockRejectedValue(new Error('redis down'));

      await say('reagendar');

      expect(convoState.state).toBe('NEEDS_HUMAN');
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/recepción/i);
    });

    it('Intent.REPROGRAMAR del LLM sigue el mismo camino que "reagendar"', async () => {
      intent.detect.mockResolvedValue(Intent.REPROGRAMAR);

      await say('quiero mover mi turno de la semana que viene');

      expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toContain('/cita?t=');
    });

    it('Intent.CANCELAR ofrece el link antes de pedir la palabra explícita', async () => {
      intent.detect.mockResolvedValue(Intent.CANCELAR);

      await say('creo que no voy a poder ir el martes');

      const msg = waha.sendText.mock.calls.at(-1)![2];
      expect(msg).toContain('/cita?t=');
      expect(msg).toMatch(/\*CANCELAR\*/);
      // Nunca cancela sin la palabra explícita.
      expect(prisma.appointment.update).not.toHaveBeenCalled();
    });

    it('"CANCELAR" explícito sigue cancelando en el chat, sin link de por medio', async () => {
      await say('cancelar');

      expect(prisma.appointment.update).toHaveBeenCalledWith({
        where: { id: 'appt-7' },
        data: expect.objectContaining({ status: 'CANCELADA' }),
      });
    });

    it('sin cita próxima: responde que no la encontró y no toca reminders', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);

      // Verbo explícito: no pasa por el gate de contexto, llega al handler.
      await say('confirmo');

      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
      expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/No encontré una cita/i);
    });

    it('paciente desconocido en este tenant: no cruza a otras clínicas', async () => {
      prisma.patient.findUnique.mockResolvedValue(null);
      prisma.appointment.findFirst.mockResolvedValue(null);

      await say('cancelar');

      // Se busca por conversationId (siempre acotado a la clínica) y por
      // teléfono; ninguna de las dos vías cruza de tenant.
      for (const call of prisma.appointment.findFirst.mock.calls) {
        expect(call[0].where.clinicId).toBe('clinic-A');
      }
      expect(prisma.appointment.update).not.toHaveBeenCalled();
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      expect(waha.sendText.mock.calls.at(-1)![2]).toMatch(/No encontré una cita/i);
    });

    it('chat @lid sin teléfono ni cita resoluble: deriva a recepción', async () => {
      // El `upsert` mockeado devuelve `convoState`, así que el estado de la
      // conversación hay que fijarlo acá: un chat @lid no tiene teléfono.
      convoState.phone = null;
      prisma.appointment.findFirst.mockResolvedValue(null);

      await bot.handleIncoming({
        clinicId: 'clinic-A',
        chatId: 'abc123@lid',
        phone: null,
        lid: 'abc123',
        text: 'confirmo',
      });

      // Sí se intenta resolver por conversationId (S5); lo que no hay es nada
      // que resolver, y sin teléfono tampoco hay segunda vía.
      expect(prisma.patient.findUnique).not.toHaveBeenCalled();
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

    it('busca el recordatorio SENT de ESA cita y dentro de la ventana de 48 h', async () => {
      await say('sí');

      const where = prisma.reminder.findFirst.mock.calls[0][0].where;
      expect(where.status).toBe('SENT');
      expect(where.sentAt.gte).toBeInstanceOf(Date);
      expect(Date.now() - where.sentAt.gte.getTime()).toBeCloseTo(
        48 * 3600 * 1000,
        -4,
      );
      // Por `appointmentId` de la cita ya resuelta: el aislamiento por tenant
      // lo garantiza `findUpcomingAppointment`, que filtra por clinicId en
      // todas sus vías. No hace falta repetirlo acá.
      expect(where.appointmentId).toBe('appt-7');
    });

    it('"sí" suelto SIN contexto de confirmación: responde el menú, no "no encontré cita"', async () => {
      prisma.reminder.findFirst.mockResolvedValue(null);

      await say('sí');

      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
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

    it('una cita de OTRA clínica nunca se resuelve: todas las vías filtran por clinicId', async () => {
      // Simula que la única cita abierta del sistema es de otro tenant: las
      // tres vías de `findUpcomingAppointment` llevan clinicId, así que
      // ninguna la ve.
      prisma.appointment.findFirst.mockImplementation(async ({ where }: any) =>
        where.clinicId === 'clinic-A' ? null : { id: 'appt-de-otra-clinica' },
      );

      await say('sí');

      // Ninguna de las vías devuelve la cita ajena, y todas llevan clinicId.
      for (const call of prisma.appointment.findFirst.mock.calls) {
        expect(call[0].where.clinicId).toBe('clinic-A');
      }
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
