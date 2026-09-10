import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { DateTime, Settings } from 'luxon';
import { requestContext } from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { createRemindersWorker } from './reminders.processor';

/**
 * Tests del worker de recordatorios (consumer BullMQ).
 * Mockeamos `bullmq.Worker` para capturar el processor y ejecutarlo a mano
 * con jobs sintéticos — sin Redis. Cubre SPEC §"Recordatorios anti no-show":
 * envío del recordatorio, transición PENDIENTE → EN_RIESGO al vencer el
 * umbral, alerta a recepción e idempotencia.
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

const ZONE = 'America/Caracas';
const NOW = DateTime.fromISO('2026-09-11T10:00:00', { zone: ZONE });
// Sábado 12/09/2026 10:00 hora clínica.
const START_AT = DateTime.fromISO('2026-09-12T10:00:00', { zone: ZONE });

const PATIENT_PHONE = '+584141234567';
const PATIENT_NAME = 'Ana Pérez';

function makeClinic(overrides: Partial<any> = {}) {
  return {
    id: 'clinic-A',
    name: 'Clínica A',
    timezone: ZONE,
    locale: 'es',
    wahaSession: 'clinic-a-session',
    reminderOffsetsH: [24, 3],
    confirmThresholdH: 6,
    ...overrides,
  };
}

function makeAppointment(overrides: Partial<any> = {}) {
  return {
    id: 'appt-1',
    clinicId: 'clinic-A',
    patientId: 'pat-1',
    serviceId: 'svc-1',
    professionalId: 'prof-1',
    status: 'PENDIENTE',
    startAt: START_AT.toJSDate(),
    endAt: START_AT.plus({ minutes: 30 }).toJSDate(),
    clinic: makeClinic(),
    patient: { id: 'pat-1', clinicId: 'clinic-A', phone: PATIENT_PHONE, name: PATIENT_NAME },
    service: { id: 'svc-1', clinicId: 'clinic-A', name: 'Consulta general' },
    professional: { id: 'prof-1', clinicId: 'clinic-A', name: 'Dra. Ríos' },
    ...overrides,
  };
}

function makeReminder(overrides: Partial<any> = {}) {
  return {
    id: 'rem-1',
    appointmentId: 'appt-1',
    offsetH: 24,
    fireAt: START_AT.minus({ hours: 24 }).toJSDate(),
    status: 'SCHEDULED',
    jobId: 'reminder-rem-1',
    sentAt: null,
    appointment: makeAppointment(),
    ...overrides,
  };
}

function makeJob(name: string, data: Record<string, unknown>, id = `${name}-job`) {
  return { id, name, data, attemptsMade: 0 } as any;
}

describe('RemindersProcessor (createRemindersWorker)', () => {
  let prisma: Deep<PrismaService>;
  let waha: Deep<WahaService>;
  let process: (job: any) => Promise<unknown>;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    Settings.now = () => NOW.toMillis();
    delete global.process.env.SENTRY_ENABLED;
    delete global.process.env.SENTRY_DSN;

    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma = {
      reminder: {
        findUnique: jest.fn().mockResolvedValue(makeReminder()),
        update: jest.fn().mockResolvedValue({}),
      },
      appointment: {
        findUnique: jest.fn().mockResolvedValue(makeAppointment()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'convo-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    waha = { sendText: jest.fn().mockResolvedValue(undefined) };

    const worker = createRemindersWorker(
      { host: 'localhost', port: 6379 },
      prisma as unknown as PrismaService,
      waha as unknown as WahaService,
    ) as any;
    process = worker.processor;
  });

  afterEach(() => {
    Settings.now = () => Date.now();
    jest.restoreAllMocks();
    (Sentry.captureException as jest.Mock).mockClear();
  });

  it('registra el Worker sobre la cola "reminders" con la conexión indicada', () => {
    const { Worker } = jest.requireMock('bullmq');
    expect(Worker).toHaveBeenCalledWith(
      'reminders',
      expect.any(Function),
      { connection: { host: 'localhost', port: 6379 } },
    );
  });

  describe('send-reminder', () => {
    it('envía el recordatorio por WAHA con fecha en la TZ/locale de la clínica y marca el Reminder SENT', async () => {
      await process(makeJob('send-reminder', { reminderId: 'rem-1' }));

      expect(prisma.reminder.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'rem-1' } }),
      );
      expect(waha.sendText).toHaveBeenCalledTimes(1);
      const [session, phone, text] = waha.sendText.mock.calls[0];
      expect(session).toBe('clinic-a-session');
      expect(phone).toBe(PATIENT_PHONE);
      expect(text).toContain(`Hola ${PATIENT_NAME}`);
      expect(text).toContain('Consulta general');
      expect(text).toContain('Clínica A');
      // 12/09/2026 es sábado; formato "cccc d 'de' LLLL, HH:mm" en es.
      expect(text).toContain('sábado 12 de septiembre, 10:00');
      expect(text).toMatch(/\*SÍ\*/);
      expect(text).toMatch(/\*REAGENDAR\*/);
      expect(text).toMatch(/\*CANCELAR\*/);

      expect(prisma.reminder.update).toHaveBeenCalledWith({
        where: { id: 'rem-1' },
        data: { status: 'SENT', sentAt: NOW.toJSDate() },
      });
    });

    it('formatea la hora en la zona de la clínica aunque el proceso corra en otra TZ', async () => {
      // Misma cita (14:00Z) para una clínica en São Paulo → 11:00 local.
      prisma.reminder.findUnique.mockResolvedValue(
        makeReminder({
          appointment: makeAppointment({
            clinic: makeClinic({ timezone: 'America/Sao_Paulo' }),
          }),
        }),
      );

      await process(makeJob('send-reminder', { reminderId: 'rem-1' }));

      const text = waha.sendText.mock.calls[0][2];
      expect(text).toContain('sábado 12 de septiembre, 11:00');
    });

    it('usa el locale de la clínica para el nombre del día/mes (pt)', async () => {
      prisma.reminder.findUnique.mockResolvedValue(
        makeReminder({
          appointment: makeAppointment({ clinic: makeClinic({ locale: 'pt' }) }),
        }),
      );

      await process(makeJob('send-reminder', { reminderId: 'rem-1' }));

      const text = waha.sendText.mock.calls[0][2];
      expect(text).toContain('sábado 12 de setembro, 10:00');
    });

    it('saluda sin nombre cuando el paciente no tiene nombre registrado', async () => {
      prisma.reminder.findUnique.mockResolvedValue(
        makeReminder({
          appointment: makeAppointment({
            patient: { id: 'pat-1', clinicId: 'clinic-A', phone: PATIENT_PHONE, name: null },
          }),
        }),
      );

      await process(makeJob('send-reminder', { reminderId: 'rem-1' }));

      const text = waha.sendText.mock.calls[0][2];
      expect(text).toMatch(/^Hola, reservaste/);
    });

    it('es idempotente: si el Reminder ya no está SCHEDULED (ej. SENT) no reenvía', async () => {
      prisma.reminder.findUnique.mockResolvedValue(makeReminder({ status: 'SENT' }));

      await process(makeJob('send-reminder', { reminderId: 'rem-1' }));

      expect(waha.sendText).not.toHaveBeenCalled();
      expect(prisma.reminder.update).not.toHaveBeenCalled();
    });

    it('no envía si el Reminder fue CANCELED (cita reprogramada)', async () => {
      prisma.reminder.findUnique.mockResolvedValue(makeReminder({ status: 'CANCELED' }));
      await process(makeJob('send-reminder', { reminderId: 'rem-1' }));
      expect(waha.sendText).not.toHaveBeenCalled();
    });

    it.each(['CANCELADA', 'NO_SHOW'])(
      'no envía si la cita ya está %s',
      async (status) => {
        prisma.reminder.findUnique.mockResolvedValue(
          makeReminder({ appointment: makeAppointment({ status }) }),
        );

        await process(makeJob('send-reminder', { reminderId: 'rem-1' }));

        expect(waha.sendText).not.toHaveBeenCalled();
        expect(prisma.reminder.update).not.toHaveBeenCalled();
      },
    );

    // Regresión: antes el processor sólo filtraba CANCELADA/NO_SHOW y una
    // cita ya ATENDIDA recibía "te recordamos tu cita… responde SÍ".
    it('no envía si la cita ya está ATENDIDA', async () => {
      prisma.reminder.findUnique.mockResolvedValue(
        makeReminder({ appointment: makeAppointment({ status: 'ATENDIDA' }) }),
      );

      await process(makeJob('send-reminder', { reminderId: 'rem-1' }));

      expect(waha.sendText).not.toHaveBeenCalled();
      expect(prisma.reminder.update).not.toHaveBeenCalled();
    });

    it.each(['PENDIENTE', 'EN_RIESGO', 'CONFIRMADA'])(
      'sí envía cuando la cita está %s (segundo aviso incluso ya confirmada)',
      async (status) => {
        prisma.reminder.findUnique.mockResolvedValue(
          makeReminder({ appointment: makeAppointment({ status }) }),
        );
        await process(makeJob('send-reminder', { reminderId: 'rem-1' }));
        expect(waha.sendText).toHaveBeenCalledTimes(1);
      },
    );

    it('si el Reminder no existe en DB no envía nada', async () => {
      prisma.reminder.findUnique.mockResolvedValue(null);
      await process(makeJob('send-reminder', { reminderId: 'ghost' }));
      expect(waha.sendText).not.toHaveBeenCalled();
    });

    it('job sin reminderId válido: warn y no consulta DB', async () => {
      await process(makeJob('send-reminder', { reminderId: 42 }));
      expect(prisma.reminder.findUnique).not.toHaveBeenCalled();
      expect(waha.sendText).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/sin reminderId/));
    });

    it('si WAHA falla: propaga el error (retry BullMQ) y NO marca el Reminder SENT', async () => {
      waha.sendText.mockRejectedValue(new Error('WAHA 503'));

      await expect(
        process(makeJob('send-reminder', { reminderId: 'rem-1' })),
      ).rejects.toThrow('WAHA 503');

      expect(prisma.reminder.update).not.toHaveBeenCalled();
    });

    it('con Sentry habilitado, el fallo se reporta con tags de cola/job/tenant y se relanza', async () => {
      global.process.env.SENTRY_ENABLED = 'true';
      global.process.env.SENTRY_DSN = 'https://x@sentry.io/1';
      waha.sendText.mockRejectedValue(new Error('WAHA 503'));

      await expect(
        process(
          makeJob('send-reminder', { reminderId: 'rem-1', clinicId: 'clinic-A', requestId: 'req-9' }),
        ),
      ).rejects.toThrow('WAHA 503');

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      const [, ctx] = (Sentry.captureException as jest.Mock).mock.calls[0];
      expect(ctx.tags).toEqual(
        expect.objectContaining({
          queue: 'reminders',
          jobName: 'send-reminder',
          clinicId: 'clinic-A',
          attempt: '1',
        }),
      );
      expect(ctx.extra.requestId).toBe('req-9');
    });

    it('sin Sentry habilitado no llama a captureException', async () => {
      waha.sendText.mockRejectedValue(new Error('boom'));
      await expect(process(makeJob('send-reminder', { reminderId: 'rem-1' }))).rejects.toThrow();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('hidrata el requestContext con requestId/clinicId del job durante el procesamiento', async () => {
      let seen: any;
      prisma.reminder.findUnique.mockImplementation(async () => {
        seen = requestContext.getStore();
        return makeReminder();
      });

      await process(
        makeJob('send-reminder', { reminderId: 'rem-1', requestId: 'req-42', clinicId: 'clinic-A' }),
      );

      expect(seen).toEqual({ requestId: 'req-42', clinicId: 'clinic-A' });
    });

    it('genera un requestId propio si el job no trae uno (jobs legacy)', async () => {
      let seen: any;
      prisma.reminder.findUnique.mockImplementation(async () => {
        seen = requestContext.getStore();
        return makeReminder();
      });

      await process(makeJob('send-reminder', { reminderId: 'rem-1' }));

      expect(typeof seen.requestId).toBe('string');
      expect(seen.requestId.length).toBeGreaterThan(0);
      expect(seen.clinicId).toBeUndefined();
    });

    it('no loguea PII del paciente (teléfono ni nombre) al enviar', async () => {
      await process(makeJob('send-reminder', { reminderId: 'rem-1' }));

      const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls]
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).toContain('Recordatorio enviado');
      expect(logged).not.toContain(PATIENT_PHONE);
      expect(logged).not.toContain('4141234567');
      expect(logged).not.toContain(PATIENT_NAME);
    });
  });

  describe('check-risk', () => {
    it('cita PENDIENTE al vencer el umbral → EN_RIESGO y alerta a recepción (NEEDS_HUMAN + mensaje)', async () => {
      await process(makeJob('check-risk', { appointmentId: 'appt-1' }));

      // Transición atómica: solo si SIGUE PENDIENTE.
      expect(prisma.appointment.updateMany).toHaveBeenCalledWith({
        where: { id: 'appt-1', status: 'PENDIENTE' },
        data: { status: 'EN_RIESGO' },
      });

      // Multi-tenant: la conversación se busca dentro de la clínica de la cita.
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            clinicId: 'clinic-A',
            OR: [{ patientId: 'pat-1' }, { phone: PATIENT_PHONE }],
          }),
        }),
      );

      expect(prisma.conversation.update).toHaveBeenCalledTimes(1);
      const upd = prisma.conversation.update.mock.calls[0][0];
      expect(upd.where).toEqual({ id: 'convo-1' });
      expect(upd.data.state).toBe('NEEDS_HUMAN');
      expect(upd.data.flowStep).toBeNull();
      const body: string = upd.data.messages.create.body;
      expect(upd.data.messages.create.direction).toBe('OUT');
      expect(body).toContain('EN_RIESGO');
      expect(body).toContain(PATIENT_NAME);
      expect(body).toContain('Consulta general');
      expect(body).toContain('Dra. Ríos');
      expect(body).toContain('sábado 12 de septiembre, 10:00');
    });

    it('cita ya CONFIRMADA: updateMany no matchea → no cambia estado ni alerta', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment({ status: 'CONFIRMADA' }));
      prisma.appointment.updateMany.mockResolvedValue({ count: 0 });

      await process(makeJob('check-risk', { appointmentId: 'appt-1' }));

      // El filtro por status es lo que protege la cita confirmada.
      expect(prisma.appointment.updateMany.mock.calls[0][0].where.status).toBe('PENDIENTE');
      expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });

    it.each(['CANCELADA', 'ATENDIDA', 'NO_SHOW', 'EN_RIESGO'])(
      'cita %s: no alerta a recepción',
      async (status) => {
        prisma.appointment.findUnique.mockResolvedValue(makeAppointment({ status }));
        prisma.appointment.updateMany.mockResolvedValue({ count: 0 });

        await process(makeJob('check-risk', { appointmentId: 'appt-1' }));

        expect(prisma.conversation.update).not.toHaveBeenCalled();
      },
    );

    it('es idempotente: ejecutar el job dos veces alerta una sola vez', async () => {
      // Simulamos la fila real: la 1ra updateMany transiciona, la 2da no matchea.
      let status = 'PENDIENTE';
      prisma.appointment.updateMany.mockImplementation(async ({ where }: any) => {
        if (status === where.status) {
          status = 'EN_RIESGO';
          return { count: 1 };
        }
        return { count: 0 };
      });

      await process(makeJob('check-risk', { appointmentId: 'appt-1' }));
      await process(makeJob('check-risk', { appointmentId: 'appt-1' }));

      expect(prisma.appointment.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.conversation.update).toHaveBeenCalledTimes(1);
    });

    it('usa la fecha de alerta formateada con el nombre del paciente o su teléfono como fallback', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        makeAppointment({
          patient: { id: 'pat-1', clinicId: 'clinic-A', phone: PATIENT_PHONE, name: null },
        }),
      );

      await process(makeJob('check-risk', { appointmentId: 'appt-1' }));

      const body: string = prisma.conversation.update.mock.calls[0][0].data.messages.create.body;
      expect(body).toContain(`Paciente: ${PATIENT_PHONE}`);
    });

    it('sin conversación asociada: marca EN_RIESGO igual, loguea warn y no revienta', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      await expect(
        process(makeJob('check-risk', { appointmentId: 'appt-1' })),
      ).resolves.toBeUndefined();

      expect(prisma.appointment.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/sin conversación/));
    });

    it('si la cita no existe no hace nada', async () => {
      prisma.appointment.findUnique.mockResolvedValue(null);
      await process(makeJob('check-risk', { appointmentId: 'ghost' }));
      expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
    });

    it('job sin appointmentId válido: warn y no consulta DB', async () => {
      await process(makeJob('check-risk', {}));
      expect(prisma.appointment.findUnique).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/sin appointmentId/));
    });

    it('no loguea PII del paciente al marcar EN_RIESGO', async () => {
      await process(makeJob('check-risk', { appointmentId: 'appt-1' }));

      const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls]
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).toContain('EN_RIESGO');
      expect(logged).not.toContain(PATIENT_PHONE);
      expect(logged).not.toContain(PATIENT_NAME);
    });

    it('si falla la escritura de la alerta, el error se propaga para reintento', async () => {
      prisma.conversation.update.mockRejectedValue(new Error('db down'));
      await expect(
        process(makeJob('check-risk', { appointmentId: 'appt-1' })),
      ).rejects.toThrow('db down');
    });
  });

  it('job desconocido: warn y no toca DB ni WAHA', async () => {
    await process(makeJob('otra-cosa', {}));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/desconocido: otra-cosa/));
    expect(waha.sendText).not.toHaveBeenCalled();
    expect(prisma.reminder.findUnique).not.toHaveBeenCalled();
    expect(prisma.appointment.findUnique).not.toHaveBeenCalled();
  });
});
