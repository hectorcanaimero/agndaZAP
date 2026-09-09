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

      // Multi-tenant: la conversación se busca por clinicId + phone.
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
        where: { clinicId: 'clinic-A', phone: PATIENT_PHONE },
      });
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'convo-1' },
        data: {
          flowStep: 'AWAITING_NPS_SCORE',
          flowData: { feedbackAppointmentId: 'appt-1' },
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

    it('sin conversación previa: envía el prompt pero no puede armar la sub-FSM (comportamiento actual)', async () => {
      // Caso: paciente que agendó por la página pública y nunca chateó con el
      // bot. Hoy el prompt sale igual; la respuesta "5" caerá al LLM porque no
      // hay Conversation con flowStep. Documentado como hallazgo en el PR.
      prisma.conversation.findFirst.mockResolvedValue(null);

      await process(makeJob('send-follow-up', { appointmentId: 'appt-1' }));

      expect(waha.sendText).toHaveBeenCalledTimes(1);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('si WAHA falla: propaga el error (retry BullMQ) y no marca la conversación', async () => {
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
