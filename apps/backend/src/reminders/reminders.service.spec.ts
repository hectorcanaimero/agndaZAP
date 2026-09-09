import { Queue } from 'bullmq';
import { DateTime, Settings } from 'luxon';
import {
  RequestContextService,
  requestContext,
} from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { RemindersService } from './reminders.service';

/**
 * Tests del motor de recordatorios (producer BullMQ).
 * Cubren SPEC §"Recordatorios": offsets por clínica (default 24h/3h), jobId
 * determinista `reminder-{id}` / `risk-{apptId}`, no programar en el pasado,
 * idempotencia al reprogramar y cancelación de jobs.
 *
 * El reloj se fija con `Settings.now` de Luxon (el service usa `DateTime.utc()`
 * y `DateTime.now()`, nunca `new Date()` naive).
 */

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

const ZONE = 'America/Caracas'; // UTC-4, sin DST

// "Ahora" fijo: jueves 10/09/2026 08:00 en la clínica (12:00Z).
const NOW = DateTime.fromISO('2026-09-10T08:00:00', { zone: ZONE });
// Cita: sábado 12/09/2026 10:00 en la clínica → 50h después de NOW.
const START_AT = DateTime.fromISO('2026-09-12T10:00:00', { zone: ZONE });

const HOUR_MS = 3_600_000;

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
  const clinic = makeClinic(overrides.clinic ?? {});
  return {
    id: 'appt-1',
    clinicId: clinic.id,
    patientId: 'pat-1',
    status: 'PENDIENTE',
    startAt: START_AT.toJSDate(),
    endAt: START_AT.plus({ minutes: 30 }).toJSDate(),
    ...overrides,
    clinic,
  };
}

describe('RemindersService', () => {
  let prisma: Deep<PrismaService>;
  let queue: Deep<Queue>;
  let service: RemindersService;
  /** Jobs "vivos" en la cola fake, indexados por jobId. */
  let jobs: Map<string, { id: string; remove: jest.Mock }>;

  beforeEach(() => {
    Settings.now = () => NOW.toMillis();

    jobs = new Map();
    queue = {
      add: jest.fn().mockImplementation(async (_name: string, _data: any, opts: any) => {
        const job = { id: opts.jobId, remove: jest.fn().mockResolvedValue(undefined) };
        jobs.set(opts.jobId, job);
        return job;
      }),
      getJob: jest.fn().mockImplementation(async (id: string) => jobs.get(id) ?? null),
    };

    prisma = {
      appointment: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeAppointment()),
        update: jest.fn().mockResolvedValue({}),
      },
      reminder: {
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: `rem-${data.offsetH}h`,
          jobId: null,
          sentAt: null,
          ...data,
        })),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    service = new RemindersService(
      prisma as unknown as PrismaService,
      queue as unknown as Queue,
      new RequestContextService(),
    );
  });

  afterEach(() => {
    Settings.now = () => Date.now();
    jest.restoreAllMocks();
  });

  describe('scheduleForAppointment', () => {
    it('programa exactamente dos recordatorios (24h y 3h) con delay relativo a startAt y jobId determinista', async () => {
      await service.scheduleForAppointment('appt-1');

      expect(prisma.appointment.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'appt-1' } }),
      );

      // Dos filas Reminder con fireAt = startAt - offset (en UTC, sin drift de TZ).
      expect(prisma.reminder.create).toHaveBeenCalledTimes(2);
      const created = prisma.reminder.create.mock.calls.map((c: any) => c[0].data);
      expect(created).toEqual([
        expect.objectContaining({
          appointmentId: 'appt-1',
          offsetH: 24,
          status: 'SCHEDULED',
          fireAt: START_AT.minus({ hours: 24 }).toJSDate(),
        }),
        expect.objectContaining({
          appointmentId: 'appt-1',
          offsetH: 3,
          status: 'SCHEDULED',
          fireAt: START_AT.minus({ hours: 3 }).toJSDate(),
        }),
      ]);

      // Jobs send-reminder: delay = fireAt - now. NOW+50h = startAt.
      const sendJobs = queue.add.mock.calls.filter((c: any) => c[0] === 'send-reminder');
      expect(sendJobs).toHaveLength(2);
      expect(sendJobs[0][1]).toEqual(expect.objectContaining({ reminderId: 'rem-24h' }));
      expect(sendJobs[0][2]).toEqual(
        expect.objectContaining({ delay: 26 * HOUR_MS, jobId: 'reminder-rem-24h' }),
      );
      expect(sendJobs[1][1]).toEqual(expect.objectContaining({ reminderId: 'rem-3h' }));
      expect(sendJobs[1][2]).toEqual(
        expect.objectContaining({ delay: 47 * HOUR_MS, jobId: 'reminder-rem-3h' }),
      );

      // El jobId físico se persiste en la fila Reminder para poder cancelar luego.
      expect(prisma.reminder.update).toHaveBeenCalledWith({
        where: { id: 'rem-24h' },
        data: { jobId: 'reminder-rem-24h' },
      });
      expect(prisma.reminder.update).toHaveBeenCalledWith({
        where: { id: 'rem-3h' },
        data: { jobId: 'reminder-rem-3h' },
      });
    });

    it('programa el job check-risk en startAt - confirmThresholdH con jobId risk-{apptId}', async () => {
      await service.scheduleForAppointment('appt-1');

      const riskJobs = queue.add.mock.calls.filter((c: any) => c[0] === 'check-risk');
      expect(riskJobs).toHaveLength(1);
      expect(riskJobs[0][1]).toEqual(expect.objectContaining({ appointmentId: 'appt-1' }));
      // Umbral 6h → dispara 44h después de NOW.
      expect(riskJobs[0][2]).toEqual(
        expect.objectContaining({ delay: 44 * HOUR_MS, jobId: 'risk-appt-1' }),
      );
    });

    it('el delay respeta la TZ de la clínica (misma hora local en otra zona → distinto instante UTC)', async () => {
      // Misma "10:00 del 12/09" pero en São Paulo (UTC-3): es 1h ANTES en UTC
      // que la de Caracas, así que todos los delays se acortan 1h.
      const spStart = DateTime.fromISO('2026-09-12T10:00:00', {
        zone: 'America/Sao_Paulo',
      });
      prisma.appointment.findUniqueOrThrow.mockResolvedValue(
        makeAppointment({
          startAt: spStart.toJSDate(),
          clinic: { timezone: 'America/Sao_Paulo' },
        }),
      );

      await service.scheduleForAppointment('appt-1');

      const delays = queue.add.mock.calls.map((c: any) => [c[0], c[2].delay]);
      expect(delays).toEqual([
        ['send-reminder', 25 * HOUR_MS],
        ['send-reminder', 46 * HOUR_MS],
        ['check-risk', 43 * HOUR_MS],
      ]);
    });

    it('cita a menos de 24h: solo programa el recordatorio de 3h (nunca jobs en el pasado)', async () => {
      // Cita en 10h → el de 24h ya pasó, el de 3h dispara en 7h, risk (6h) en 4h.
      const soon = NOW.plus({ hours: 10 });
      prisma.appointment.findUniqueOrThrow.mockResolvedValue(
        makeAppointment({ startAt: soon.toJSDate() }),
      );

      await service.scheduleForAppointment('appt-1');

      expect(prisma.reminder.create).toHaveBeenCalledTimes(1);
      expect(prisma.reminder.create.mock.calls[0][0].data.offsetH).toBe(3);

      const names = queue.add.mock.calls.map((c: any) => c[0]);
      expect(names).toEqual(['send-reminder', 'check-risk']);
      expect(queue.add.mock.calls[0][2].delay).toBe(7 * HOUR_MS);
      expect(queue.add.mock.calls[1][2].delay).toBe(4 * HOUR_MS);
    });

    it('cita a menos de 3h: no crea recordatorios ni check-risk (umbral ya vencido)', async () => {
      const veryClose = NOW.plus({ hours: 2 });
      prisma.appointment.findUniqueOrThrow.mockResolvedValue(
        makeAppointment({ startAt: veryClose.toJSDate() }),
      );

      await service.scheduleForAppointment('appt-1');

      expect(prisma.reminder.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('un offset que cae exactamente en "ahora" se descarta (fireAt <= now)', async () => {
      // Cita en exactamente 24h → fireAt(24h) === now → se salta; el de 3h sí.
      prisma.appointment.findUniqueOrThrow.mockResolvedValue(
        makeAppointment({ startAt: NOW.plus({ hours: 24 }).toJSDate() }),
      );

      await service.scheduleForAppointment('appt-1');

      const offsets = prisma.reminder.create.mock.calls.map((c: any) => c[0].data.offsetH);
      expect(offsets).toEqual([3]);
    });

    it('respeta offsets configurables por clínica (reminderOffsetsH=[48,12,1])', async () => {
      prisma.appointment.findUniqueOrThrow.mockResolvedValue(
        makeAppointment({ clinic: { reminderOffsetsH: [48, 12, 1] } }),
      );

      await service.scheduleForAppointment('appt-1');

      const offsets = prisma.reminder.create.mock.calls.map((c: any) => c[0].data.offsetH);
      expect(offsets).toEqual([48, 12, 1]);
      const sendDelays = queue.add.mock.calls
        .filter((c: any) => c[0] === 'send-reminder')
        .map((c: any) => c[2].delay);
      expect(sendDelays).toEqual([2 * HOUR_MS, 38 * HOUR_MS, 49 * HOUR_MS]);
    });

    it('usa el umbral de riesgo configurado por clínica (confirmThresholdH=12)', async () => {
      prisma.appointment.findUniqueOrThrow.mockResolvedValue(
        makeAppointment({ clinic: { confirmThresholdH: 12 } }),
      );

      await service.scheduleForAppointment('appt-1');

      const risk = queue.add.mock.calls.find((c: any) => c[0] === 'check-risk')!;
      expect(risk[2].delay).toBe(38 * HOUR_MS);
    });

    it('con reminderOffsetsH vacío no manda recordatorios pero sí vigila el riesgo', async () => {
      prisma.appointment.findUniqueOrThrow.mockResolvedValue(
        makeAppointment({ clinic: { reminderOffsetsH: [] } }),
      );

      await service.scheduleForAppointment('appt-1');

      expect(prisma.reminder.create).not.toHaveBeenCalled();
      const names = queue.add.mock.calls.map((c: any) => c[0]);
      expect(names).toEqual(['check-risk']);
    });

    it('es idempotente: al reprogramar cancela los jobs/filas previas antes de crear las nuevas', async () => {
      // Estado previo: dos reminders SCHEDULED con jobs vivos + risk job vivo.
      const oldJob24 = { id: 'reminder-old-24', remove: jest.fn().mockResolvedValue(undefined) };
      const oldJob3 = { id: 'reminder-old-3', remove: jest.fn().mockResolvedValue(undefined) };
      const oldRisk = { id: 'risk-appt-1', remove: jest.fn().mockResolvedValue(undefined) };
      jobs.set(oldJob24.id, oldJob24);
      jobs.set(oldJob3.id, oldJob3);
      jobs.set(oldRisk.id, oldRisk);
      prisma.reminder.findMany.mockResolvedValue([
        { id: 'old-24', appointmentId: 'appt-1', status: 'SCHEDULED', jobId: 'reminder-old-24' },
        { id: 'old-3', appointmentId: 'appt-1', status: 'SCHEDULED', jobId: 'reminder-old-3' },
      ]);

      await service.scheduleForAppointment('appt-1');

      // Solo se buscan/cancelan los SCHEDULED de ESTA cita.
      expect(prisma.reminder.findMany).toHaveBeenCalledWith({
        where: { appointmentId: 'appt-1', status: 'SCHEDULED' },
      });
      expect(oldJob24.remove).toHaveBeenCalledTimes(1);
      expect(oldJob3.remove).toHaveBeenCalledTimes(1);
      expect(oldRisk.remove).toHaveBeenCalledTimes(1);
      expect(prisma.reminder.updateMany).toHaveBeenCalledWith({
        where: { appointmentId: 'appt-1', status: 'SCHEDULED' },
        data: { status: 'CANCELED' },
      });

      // Orden: cancelación ANTES de crear las nuevas filas.
      const cancelOrder = prisma.reminder.updateMany.mock.invocationCallOrder[0];
      const createOrder = prisma.reminder.create.mock.invocationCallOrder[0];
      expect(cancelOrder).toBeLessThan(createOrder);

      // Y se vuelven a crear exactamente 2 + risk.
      expect(prisma.reminder.create).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenCalledTimes(3);
    });

    it('serializa clinicId de la cita y requestId del contexto en job.data (correlación de logs)', async () => {
      await requestContext.run({ requestId: 'req-123', clinicId: 'clinic-A' }, () =>
        service.scheduleForAppointment('appt-1'),
      );

      for (const call of queue.add.mock.calls) {
        expect(call[1]).toEqual(
          expect.objectContaining({ requestId: 'req-123', clinicId: 'clinic-A' }),
        );
      }
    });

    it('el clinicId del job es el de la cita, no el del request context', async () => {
      // Guard multi-tenant: aunque el contexto traiga otra clínica (ej. admin
      // impersonando), el job hereda el tenant real de la cita.
      await requestContext.run({ requestId: 'req-1', clinicId: 'clinic-OTRA' }, () =>
        service.scheduleForAppointment('appt-1'),
      );

      for (const call of queue.add.mock.calls) {
        expect(call[1].clinicId).toBe('clinic-A');
      }
    });

    it('fuera de un request (worker/cron) job.data lleva requestId undefined sin fallar', async () => {
      await service.scheduleForAppointment('appt-1');
      expect(queue.add.mock.calls[0][1]).toEqual(
        expect.objectContaining({ requestId: undefined, clinicId: 'clinic-A' }),
      );
    });

    it('los jobs se crean con removeOnComplete para no acumular basura en Redis', async () => {
      await service.scheduleForAppointment('appt-1');
      for (const call of queue.add.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ removeOnComplete: true, removeOnFail: 100 }),
        );
      }
    });

    it('propaga el error si la cita no existe (findUniqueOrThrow)', async () => {
      prisma.appointment.findUniqueOrThrow.mockRejectedValue(new Error('No Appointment found'));
      await expect(service.scheduleForAppointment('nope')).rejects.toThrow(/No Appointment/);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('cancelForAppointment', () => {
    it('elimina los jobs de los reminders SCHEDULED, los marca CANCELED y borra el check-risk', async () => {
      const j1 = { id: 'reminder-r1', remove: jest.fn().mockResolvedValue(undefined) };
      const risk = { id: 'risk-appt-1', remove: jest.fn().mockResolvedValue(undefined) };
      jobs.set(j1.id, j1);
      jobs.set(risk.id, risk);
      prisma.reminder.findMany.mockResolvedValue([
        { id: 'r1', appointmentId: 'appt-1', status: 'SCHEDULED', jobId: 'reminder-r1' },
      ]);

      await service.cancelForAppointment('appt-1');

      expect(queue.getJob).toHaveBeenCalledWith('reminder-r1');
      expect(queue.getJob).toHaveBeenCalledWith('risk-appt-1');
      expect(j1.remove).toHaveBeenCalledTimes(1);
      expect(risk.remove).toHaveBeenCalledTimes(1);
      expect(prisma.reminder.updateMany).toHaveBeenCalledWith({
        where: { appointmentId: 'appt-1', status: 'SCHEDULED' },
        data: { status: 'CANCELED' },
      });
    });

    it('no toca reminders ya SENT (solo filtra SCHEDULED)', async () => {
      await service.cancelForAppointment('appt-1');
      const where = prisma.reminder.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('SCHEDULED');
      const updWhere = prisma.reminder.updateMany.mock.calls[0][0].where;
      expect(updWhere.status).toBe('SCHEDULED');
    });

    it('es idempotente: si los jobs ya no existen en Redis no falla', async () => {
      prisma.reminder.findMany.mockResolvedValue([
        { id: 'r1', appointmentId: 'appt-1', status: 'SCHEDULED', jobId: 'reminder-r1' },
        { id: 'r2', appointmentId: 'appt-1', status: 'SCHEDULED', jobId: null },
      ]);
      // getJob devuelve null para todo (jobs ya consumidos/borrados).

      await expect(service.cancelForAppointment('appt-1')).resolves.toBeUndefined();
      // El reminder sin jobId no consulta Redis.
      expect(queue.getJob).toHaveBeenCalledTimes(2); // reminder-r1 + risk
      expect(prisma.reminder.updateMany).toHaveBeenCalledTimes(1);
    });

    it('tolera que job.remove() falle (job ya en ejecución) y sigue cancelando el resto', async () => {
      const locked = {
        id: 'reminder-r1',
        remove: jest.fn().mockRejectedValue(new Error('Job is locked')),
      };
      const risk = { id: 'risk-appt-1', remove: jest.fn().mockResolvedValue(undefined) };
      jobs.set(locked.id, locked);
      jobs.set(risk.id, risk);
      prisma.reminder.findMany.mockResolvedValue([
        { id: 'r1', appointmentId: 'appt-1', status: 'SCHEDULED', jobId: 'reminder-r1' },
      ]);

      await expect(service.cancelForAppointment('appt-1')).resolves.toBeUndefined();
      expect(risk.remove).toHaveBeenCalledTimes(1);
      expect(prisma.reminder.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('confirmAppointment', () => {
    it('marca la cita CONFIRMADA con confirmedAt=ahora y elimina el job check-risk', async () => {
      const risk = { id: 'risk-appt-1', remove: jest.fn().mockResolvedValue(undefined) };
      jobs.set(risk.id, risk);

      await service.confirmAppointment('appt-1');

      expect(prisma.appointment.update).toHaveBeenCalledWith({
        where: { id: 'appt-1' },
        data: { status: 'CONFIRMADA', confirmedAt: NOW.toJSDate() },
      });
      expect(queue.getJob).toHaveBeenCalledWith('risk-appt-1');
      expect(risk.remove).toHaveBeenCalledTimes(1);
    });

    it('mantiene los recordatorios pendientes como segundo aviso (no los cancela)', async () => {
      await service.confirmAppointment('appt-1');

      expect(prisma.reminder.findMany).not.toHaveBeenCalled();
      expect(prisma.reminder.updateMany).not.toHaveBeenCalled();
      // Solo consulta el risk job, nunca los reminder-*.
      expect(queue.getJob).toHaveBeenCalledTimes(1);
    });

    it('es idempotente: confirmar dos veces no falla aunque el risk job ya no exista', async () => {
      await service.confirmAppointment('appt-1');
      await expect(service.confirmAppointment('appt-1')).resolves.toBeUndefined();
      expect(prisma.appointment.update).toHaveBeenCalledTimes(2);
    });
  });
});
