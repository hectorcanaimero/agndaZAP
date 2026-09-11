import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { requestContext } from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { createFollowUpsWorker } from './follow-ups.processor';

/**
 * Tests del worker de follow-ups post-atención (ADR 0012).
 * Mockeamos `bullmq.Worker` para capturar el processor y ejecutarlo con jobs
 * sintéticos. El job `send-follow-up` manda el prompt 1-5 por WAHA y deja la
 * conversación en `flowStep=AWAITING_NPS_SCORE` con el appointmentId en
 * flowData para que el BotService interprete la próxima respuesta.
 */

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((name: string, processor: any, opts: any) => ({
    name,
    processor,
    opts,
  })),
  Job: class {},
}));

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
}));

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

const PATIENT_PHONE = '+584141234567';
const PATIENT_NAME = 'Ana Pérez';

function makeAppointment(overrides: Partial<any> = {}) {
  return {
    id: 'appt-1',
    clinicId: 'clinic-A',
    patientId: 'pat-1',
    professionalId: 'prof-1',
    status: 'ATENDIDA',
    clinic: {
      id: 'clinic-A',
      name: 'Clínica A',
      timezone: 'America/Caracas',
      locale: 'es',
      wahaSession: 'clinic-a-session',
    },
    patient: { id: 'pat-1', clinicId: 'clinic-A', phone: PATIENT_PHONE, name: PATIENT_NAME },
    professional: {
      id: 'prof-1',
      clinicId: 'clinic-A',
      name: 'Dra. Ríos',
      followUpEnabled: true,
      followUpDelayHours: 2,
    },
    ...overrides,
  };
}

function makeJob(name: string, data: Record<string, unknown>, id = `${name}-job`) {
  return { id, name, data, attemptsMade: 0 } as any;
}

describe('FollowUpsProcessor (createFollowUpsWorker)', () => {
  let prisma: Deep<PrismaService>;
  let waha: Deep<WahaService>;
  let process: (job: any) => Promise<unknown>;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    delete global.process.env.SENTRY_ENABLED;
    delete global.process.env.SENTRY_DSN;
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma = {
      appointment: { findUnique: jest.fn().mockResolvedValue(makeAppointment()) },
      feedback: { findUnique: jest.fn().mockResolvedValue(null) },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'convo-1', clinicId: 'clinic-A' }),
        upsert: jest.fn().mockResolvedValue({ id: 'convo-nueva', clinicId: 'clinic-A' }),
        update: jest.fn().mockResolvedValue({}),
      },
      message: { create: jest.fn().mockResolvedValue({}) },
    };
    waha = { sendText: jest.fn().mockResolvedValue(undefined) };

    const worker = createFollowUpsWorker(
      { host: 'localhost', port: 6379 },
      prisma as unknown as PrismaService,
      waha as unknown as WahaService,
    ) as any;
    process = worker.processor;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (Sentry.captureException as jest.Mock).mockClear();
  });

  it('registra el Worker sobre la cola "follow-ups" (separada de reminders)', () => {
    const { Worker } = jest.requireMock('bullmq');
    expect(Worker).toHaveBeenCalledWith(
      'follow-ups',
      expect.any(Function),
      { connection: { host: 'localhost', port: 6379 } },
    );
  });

  describe('send-follow-up', () => {
    it('manda el prompt 1-5 por WAHA y deja la conversación en AWAITING_NPS_SCORE con el appointmentId', async () => {
      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      expect(prisma.appointment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'appt-1' } }),
      );

      expect(waha.sendText).toHaveBeenCalledTimes(1);
      const [session, phone, text] = waha.sendText.mock.calls[0];
      expect(session).toBe('clinic-a-session');
      expect(phone).toBe(PATIENT_PHONE);
      expect(text).toContain(`Hola ${PATIENT_NAME}`);
      expect(text).toContain('Clínica A');
      expect(text).toContain('Dra. Ríos');
      expect(text).toMatch(/\*1\*/);
      expect(text).toMatch(/\*5\*/);

      // Multi-tenant: la conversación se busca siempre dentro de la clínica.
      // `orderBy updatedAt desc` desempata si hay más de una fila del paciente
      // (una @lid y una @c.us): sin él el score se perdería a ratos.
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
        where: {
          clinicId: 'clinic-A',
          OR: [{ patientId: 'pat-1' }, { phone: PATIENT_PHONE }],
        },
        orderBy: { updatedAt: 'desc' },
      });
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'convo-1' },
        data: {
          flowStep: 'AWAITING_NPS_SCORE',
          flowData: { feedbackAppointmentId: 'appt-1' },
          // La conversación no tenía patientId: la ligamos al paciente.
          patientId: 'pat-1',
        },
      });
      // Trazabilidad: el prompt queda persistido como mensaje OUT.
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: { conversationId: 'convo-1', direction: 'OUT', body: text },
      });
    });

    it('saluda sin nombre si el paciente no tiene nombre', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        makeAppointment({
          patient: { id: 'pat-1', clinicId: 'clinic-A', phone: PATIENT_PHONE, name: null },
        }),
      );
      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));
      expect(waha.sendText.mock.calls[0][2]).toMatch(/^Hola, gracias por tu visita/);
    });

    it('si el operador apagó followUpEnabled después de ATENDIDA, no envía', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        makeAppointment({
          professional: { id: 'prof-1', name: 'Dra. Ríos', followUpEnabled: false, followUpDelayHours: 2 },
        }),
      );

      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      expect(waha.sendText).not.toHaveBeenCalled();
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/followUp desactivado/));
    });

    it('es idempotente: si ya existe Feedback para la cita no reenvía el prompt', async () => {
      prisma.feedback.findUnique.mockResolvedValue({ id: 'fb-1', appointmentId: 'appt-1', score: 5 });

      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));
      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      expect(prisma.feedback.findUnique).toHaveBeenCalledWith({ where: { appointmentId: 'appt-1' } });
      expect(waha.sendText).not.toHaveBeenCalled();
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });

    it('si la cita no existe no hace nada', async () => {
      prisma.appointment.findUnique.mockResolvedValue(null);
      await process(makeJob('send-follow-up', { appointmentId: 'ghost' }));
      expect(waha.sendText).not.toHaveBeenCalled();
      expect(prisma.feedback.findUnique).not.toHaveBeenCalled();
    });

    // ── B9: sin Conversation previa, el prompt dejaba la sub-FSM sin armar ──
    // Caso real: paciente que agendó por la página pública y nunca escribió por
    // WhatsApp. Antes salía el prompt pero no había fila que marcar, así que su
    // "5" caía al clasificador LLM y el score se perdía.
    it('sin conversación previa: la crea con el chatId canónico y arma la sub-FSM', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      expect(waha.sendText).toHaveBeenCalledTimes(1);

      // Upsert por la clave única (clinicId, chatId) — tolera la carrera con un
      // mensaje entrante. El chatId es el mismo que usará WAHA al entregar la
      // respuesta: dígitos sin `+` y sufijo @c.us.
      expect(prisma.conversation.upsert).toHaveBeenCalledWith({
        where: {
          clinicId_chatId: { clinicId: 'clinic-A', chatId: '584141234567@c.us' },
        },
        create: {
          clinicId: 'clinic-A',
          chatId: '584141234567@c.us',
          phone: PATIENT_PHONE,
          patientId: 'pat-1',
          state: 'BOT',
          flowStep: 'AWAITING_NPS_SCORE',
          flowData: { feedbackAppointmentId: 'appt-1' },
        },
        update: {
          phone: PATIENT_PHONE,
          flowStep: 'AWAITING_NPS_SCORE',
          flowData: { feedbackAppointmentId: 'appt-1' },
        },
      });

      // El flowStep va DENTRO del upsert: una update posterior dejaría una
      // ventana en la que el bot podría arrancar la FSM de agendamiento y se
      // la pisaríamos.
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          conversationId: 'convo-nueva',
          direction: 'OUT',
          body: waha.sendText.mock.calls[0][2],
        },
      });
    });

    it('con conversación previa: la reusa y NO crea otra (aunque su chatId sea @lid)', async () => {
      // El paciente ya chateó desde un LID: su chatId no se puede derivar del
      // teléfono. Si hiciéramos upsert por chatId derivado tendríamos dos hilos
      // para el mismo paciente y el bot perdería el contexto.
      prisma.conversation.findFirst.mockResolvedValue({
        id: 'convo-lid',
        clinicId: 'clinic-A',
        chatId: '99887766554433@lid',
        state: 'BOT',
        patientId: 'pat-1',
      });

      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      expect(prisma.conversation.upsert).not.toHaveBeenCalled();
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'convo-lid' },
        data: {
          flowStep: 'AWAITING_NPS_SCORE',
          flowData: { feedbackAppointmentId: 'appt-1' },
          // Ya tenía patientId: no lo pisamos.
        },
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ conversationId: 'convo-lid' }),
        }),
      );
    });

    it('conversación tomada por un humano: no manda el prompt ni arma la sub-FSM', async () => {
      // Si un operador está atendiendo el chat, el prompt automático se metería
      // en medio de la charla. Y armar la sub-FSM no serviría: handleIncoming
      // corta en seco con state HUMAN, así que el score se perdería igual y el
      // flowStep quedaría colgado hasta el release() del operador.
      prisma.conversation.findFirst.mockResolvedValue({
        id: 'convo-humana',
        clinicId: 'clinic-A',
        state: 'HUMAN',
        patientId: 'pat-1',
      });

      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      expect(waha.sendText).not.toHaveBeenCalled();
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(prisma.conversation.upsert).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/atendida por humano/),
      );
    });

    it('fila legacy con el phone sin "+": el upsert la corrige en vez de duplicarla', async () => {
      // Conversación creada antes de normalizar a E.164: findFirst por phone no
      // la encuentra, pero el upsert sí da con ella por (clinicId, chatId) y la
      // rama `update` deja el phone canónico.
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.upsert.mockResolvedValue({
        id: 'convo-legacy',
        clinicId: 'clinic-A',
      });

      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      const { update } = prisma.conversation.upsert.mock.calls[0][0];
      expect(update).toEqual({
        phone: PATIENT_PHONE,
        flowStep: 'AWAITING_NPS_SCORE',
        flowData: { feedbackAppointmentId: 'appt-1' },
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          conversationId: 'convo-legacy',
          direction: 'OUT',
          body: waha.sendText.mock.calls[0][2],
        },
      });
    });

    it('si falla el marcado DESPUÉS de enviar: no relanza (la cola no reintenta) y reporta', async () => {
      // El prompt ya salió por WhatsApp. Relanzar no lo desenvía y, sin
      // `attempts` en la cola, tampoco hay reintento: solo perderíamos la
      // traza. Se registra y se reporta a Sentry.
      global.process.env.SENTRY_ENABLED = 'true';
      global.process.env.SENTRY_DSN = 'https://x@sentry.io/1';
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.upsert.mockRejectedValue(new Error('P2002'));

      await expect(
        process(makeJob('send-follow-up', { appointmentId: 'appt-1' })),
      ).resolves.toBeUndefined();

      expect(waha.sendText).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ stage: 'arm-nps-fsm' }),
        }),
      );
    });

    it('el prompt está en tuteo LATAM neutro, sin voseo', async () => {
      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      const text = waha.sendText.mock.calls[0][2];
      expect(text).toContain('Responde con un número');
      expect(text).not.toMatch(/Respondé/);
    });

    it('multi-tenant: busca y crea la conversación siempre dentro de la clínica de la cita', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      expect(prisma.conversation.findFirst.mock.calls[0][0].where.clinicId).toBe(
        'clinic-A',
      );
      const upsertArg = prisma.conversation.upsert.mock.calls[0][0];
      expect(upsertArg.where.clinicId_chatId.clinicId).toBe('clinic-A');
      expect(upsertArg.create.clinicId).toBe('clinic-A');
    });

    it('si WAHA falla: propaga el error y no marca la conversación', async () => {
      waha.sendText.mockRejectedValue(new Error('WAHA 503'));

      await expect(
        process(makeJob('send-follow-up', { appointmentId: 'appt-1' })),
      ).rejects.toThrow('WAHA 503');

      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('con Sentry habilitado reporta el fallo con tags de cola/tenant', async () => {
      global.process.env.SENTRY_ENABLED = 'true';
      global.process.env.SENTRY_DSN = 'https://x@sentry.io/1';
      waha.sendText.mockRejectedValue(new Error('WAHA 503'));

      await expect(
        process(makeJob('send-follow-up', { appointmentId: 'appt-1', clinicId: 'clinic-A' })),
      ).rejects.toThrow('WAHA 503');

      const [, ctx] = (Sentry.captureException as jest.Mock).mock.calls[0];
      expect(ctx.tags).toEqual(
        expect.objectContaining({ queue: 'follow-ups', jobName: 'send-follow-up', clinicId: 'clinic-A' }),
      );
    });

    it('hidrata el requestContext con requestId/clinicId del job', async () => {
      let seen: any;
      prisma.appointment.findUnique.mockImplementation(async () => {
        seen = requestContext.getStore();
        return makeAppointment();
      });

      await process(
        makeJob('send-follow-up', { appointmentId: 'appt-1', requestId: 'req-42', clinicId: 'clinic-A' }),
      );

      expect(seen).toEqual({ requestId: 'req-42', clinicId: 'clinic-A' });
    });

    it('no loguea PII del paciente (teléfono ni nombre)', async () => {
      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls]
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).toContain('follow-up enviado');
      expect(logged).not.toContain(PATIENT_PHONE);
      expect(logged).not.toContain('4141234567');
      expect(logged).not.toContain(PATIENT_NAME);
    });
  });

  it('ignora jobs con otro nombre sin tocar DB ni WAHA', async () => {
    await process(makeJob('otra-cosa', { appointmentId: 'appt-1' }));
    expect(prisma.appointment.findUnique).not.toHaveBeenCalled();
    expect(waha.sendText).not.toHaveBeenCalled();
  });
});
