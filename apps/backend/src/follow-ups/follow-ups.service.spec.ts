import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DateTime, Settings } from 'luxon';
import {
  RequestContextService,
  requestContext,
} from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { FollowUpsService } from './follow-ups.service';

/**
 * Tests del producer de follow-ups post-atención (ADR 0012).
 * Al pasar una cita a ATENDIDA se encola `send-follow-up` con delay
 * `professional.followUpDelayHours` solo si `followUpEnabled`; jobId
 * determinista `follow-up-{apptId}`; nunca dos feedbacks por cita.
 */

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

const ZONE = 'America/Caracas';
const NOW = DateTime.fromISO('2026-09-12T11:00:00', { zone: ZONE });
const HOUR_MS = 3_600_000;

function makeProfessional(overrides: Partial<any> = {}) {
  return {
    id: 'prof-1',
    clinicId: 'clinic-A',
    name: 'Dra. Ríos',
    followUpEnabled: true,
    followUpDelayHours: 2,
    ...overrides,
  };
}

function makeAppointment(overrides: Partial<any> = {}) {
  return {
    id: 'appt-1',
    clinicId: 'clinic-A',
    patientId: 'pat-1',
    professionalId: 'prof-1',
    status: 'ATENDIDA',
    professional: makeProfessional(),
    ...overrides,
  };
}

describe('FollowUpsService', () => {
  let prisma: Deep<PrismaService>;
  let queue: Deep<Queue>;
  let service: FollowUpsService;

  beforeEach(() => {
    Settings.now = () => NOW.toMillis();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    prisma = {
      appointment: {
        findUnique: jest.fn().mockResolvedValue(makeAppointment()),
        // Implementación de verdad, no un mock plano: el chequeo de tenant es
        // justo lo que se está probando, así que el mock tiene que respetar el
        // `clinicId` del `where` en vez de devolver siempre la cita.
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === 'appt-1' && where.clinicId === 'clinic-A'
            ? { id: 'appt-1' }
            : null,
        ),
      },
      feedback: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        // Definido a propósito: si no, el test de "usa updateMany, nunca
        // update" pasaría por `toBeUndefined()` aunque producción llamara a
        // `update` (reventaría por TypeError, con otro mensaje).
        update: jest.fn().mockResolvedValue({ id: 'fb-1' }),
        create: jest.fn().mockResolvedValue({ id: 'fb-1' }),
        updateMany: jest.fn(async ({ where }: any) => ({
          count:
            where.appointmentId === 'appt-1' && where.clinicId === 'clinic-A'
              ? 1
              : 0,
        })),
      },
    };
    queue = {
      add: jest.fn().mockImplementation(async (_n: string, _d: any, opts: any) => ({
        id: opts.jobId,
      })),
      getJob: jest.fn().mockResolvedValue(null),
    };

    service = new FollowUpsService(
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
    it('con followUpEnabled encola send-follow-up con delay=followUpDelayHours y jobId determinista', async () => {
      await requestContext.run({ requestId: 'req-7', clinicId: 'clinic-A' }, () =>
        service.scheduleForAppointment('appt-1'),
      );

      expect(prisma.appointment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'appt-1' } }),
      );
      expect(queue.add).toHaveBeenCalledTimes(1);
      const [name, data, opts] = queue.add.mock.calls[0];
      expect(name).toBe('send-follow-up');
      expect(data).toEqual({ appointmentId: 'appt-1', requestId: 'req-7', clinicId: 'clinic-A' });
      expect(opts).toEqual({
        delay: 2 * HOUR_MS,
        jobId: 'follow-up-appt-1',
        removeOnComplete: true,
        removeOnFail: 100,
      });
    });

    it('usa el delay configurado por profesional (followUpDelayHours=24)', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        makeAppointment({ professional: makeProfessional({ followUpDelayHours: 24 }) }),
      );

      await service.scheduleForAppointment('appt-1');

      expect(queue.add.mock.calls[0][2].delay).toBe(24 * HOUR_MS);
    });

    it('followUpDelayHours=0 → delay 0 (envío inmediato, útil en dev)', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        makeAppointment({ professional: makeProfessional({ followUpDelayHours: 0 }) }),
      );
      await service.scheduleForAppointment('appt-1');
      expect(queue.add.mock.calls[0][2].delay).toBe(0);
    });

    it('un delay negativo se clampea a 0 (nunca delay negativo en BullMQ)', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        makeAppointment({ professional: makeProfessional({ followUpDelayHours: -5 }) }),
      );
      await service.scheduleForAppointment('appt-1');
      expect(queue.add.mock.calls[0][2].delay).toBe(0);
    });

    it('con followUpEnabled=false no encola nada (ni consulta feedback)', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        makeAppointment({ professional: makeProfessional({ followUpEnabled: false }) }),
      );

      await service.scheduleForAppointment('appt-1');

      expect(queue.add).not.toHaveBeenCalled();
      expect(prisma.feedback.findFirst).not.toHaveBeenCalled();
    });

    it('el guard de idempotencia consulta acotado por clinicId', async () => {
      await service.scheduleForAppointment('appt-1');
      expect(prisma.feedback.findFirst).toHaveBeenCalledWith({
        where: { appointmentId: 'appt-1', clinicId: 'clinic-A' },
        select: { id: true },
      });
    });

    it('si ya existe Feedback para la cita no vuelve a encolar', async () => {
      prisma.feedback.findFirst.mockResolvedValue({ id: 'fb-1' });

      await service.scheduleForAppointment('appt-1');

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('un Feedback de OTRA clínica no bloquea el prompt de esta', async () => {
      // Sin `clinicId` en el where, una fila envenenada dejaba a la clínica
      // legítima sin recibir nunca el prompt de su propia cita.
      prisma.feedback.findFirst.mockImplementation(async ({ where }: any) =>
        where.clinicId === 'clinic-A' ? null : { id: 'fb-ajeno' },
      );

      await service.scheduleForAppointment('appt-1');

      expect(queue.add).toHaveBeenCalled();
    });

    it('si la cita no existe no falla ni encola', async () => {
      prisma.appointment.findUnique.mockResolvedValue(null);
      await expect(service.scheduleForAppointment('ghost')).resolves.toBeUndefined();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('el clinicId del job es el de la cita (tenant real), no el del contexto', async () => {
      await requestContext.run({ requestId: 'req-1', clinicId: 'clinic-OTRA' }, () =>
        service.scheduleForAppointment('appt-1'),
      );
      expect(queue.add.mock.calls[0][1].clinicId).toBe('clinic-A');
    });

    it('es idempotente por jobId: dos llamadas usan el mismo jobId follow-up-{apptId}', async () => {
      await service.scheduleForAppointment('appt-1');
      await service.scheduleForAppointment('appt-1');

      const ids = queue.add.mock.calls.map((c: any) => c[2].jobId);
      expect(ids).toEqual(['follow-up-appt-1', 'follow-up-appt-1']);
    });
  });

  describe('cancelForAppointment', () => {
    it('elimina el job follow-up-{apptId} si existe', async () => {
      const job = { id: 'follow-up-appt-1', remove: jest.fn().mockResolvedValue(undefined) };
      queue.getJob.mockResolvedValue(job);

      await service.cancelForAppointment('appt-1');

      expect(queue.getJob).toHaveBeenCalledWith('follow-up-appt-1');
      expect(job.remove).toHaveBeenCalledTimes(1);
    });

    it('no falla si el job no existe (ya enviado o nunca programado)', async () => {
      await expect(service.cancelForAppointment('appt-1')).resolves.toBeUndefined();
    });

    it('silent-fail si remove() rechaza (job en ejecución)', async () => {
      queue.getJob.mockResolvedValue({
        id: 'follow-up-appt-1',
        remove: jest.fn().mockRejectedValue(new Error('locked')),
      });
      await expect(service.cancelForAppointment('appt-1')).resolves.toBeUndefined();
    });
  });

  describe('recordFeedback', () => {
    it('crea el Feedback con clinicId, score, comment trimmed y respondedAt=ahora', async () => {
      const res = await service.recordFeedback('clinic-A', 'appt-1', 4, '  muy bien  ');

      expect(res).toEqual({ created: true });
      expect(prisma.feedback.create).toHaveBeenCalledWith({
        data: {
          clinicId: 'clinic-A',
          appointmentId: 'appt-1',
          score: 4,
          comment: 'muy bien',
          respondedAt: NOW.toJSDate(),
        },
      });
    });

    it('comment vacío o solo espacios se guarda como null', async () => {
      await service.recordFeedback('clinic-A', 'appt-1', 5, '   ');
      expect(prisma.feedback.create.mock.calls[0][0].data.comment).toBeNull();

      await service.recordFeedback('clinic-A', 'appt-1', 5);
      expect(prisma.feedback.create.mock.calls[1][0].data.comment).toBeNull();
    });

    it.each([0, 6, -1, 10])('rechaza score fuera de rango [1-5]: %s', async (score) => {
      await expect(service.recordFeedback('clinic-A', 'appt-1', score)).rejects.toThrow(
        /fuera de rango/,
      );
      expect(prisma.feedback.create).not.toHaveBeenCalled();
    });

    it.each([1, 5])('acepta los extremos del rango: %s', async (score) => {
      await expect(service.recordFeedback('clinic-A', 'appt-1', score)).resolves.toEqual({
        created: true,
      });
    });

    it('comprueba la pertenencia con clinicId dentro del where, no después', async () => {
      await service.recordFeedback('clinic-A', 'appt-1', 4);
      expect(prisma.appointment.findFirst).toHaveBeenCalledWith({
        where: { id: 'appt-1', clinicId: 'clinic-A' },
        select: { id: true },
      });
    });

    /**
     * S4. `Feedback` tiene FKs separadas a `Clinic` y a `Appointment`, así que
     * la base admite una fila con el `clinicId` de un tenant y el
     * `appointmentId` de otro. Si eso pasara, el panel de la clínica A leería
     * el score y el comentario en texto libre de un paciente de la clínica B,
     * y como `appointmentId` es unique, la clínica B ya no podría registrar
     * nunca el feedback real de esa cita.
     */
    it('cita de otra clínica: NO escribe y devuelve created:false', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const res = await service.recordFeedback('clinic-B', 'appt-1', 5, 'texto del paciente');

      expect(res).toEqual({ created: false });
      expect(prisma.feedback.create).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('cross-tenant'),
      );
    });

    it('cita inexistente: tampoco escribe', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const res = await service.recordFeedback('clinic-A', 'appt-fantasma', 3);

      expect(res).toEqual({ created: false });
      expect(prisma.feedback.create).not.toHaveBeenCalled();
    });

    it('el score inválido se rechaza antes de tocar la base', async () => {
      await expect(service.recordFeedback('clinic-A', 'appt-1', 9)).rejects.toThrow();
      expect(prisma.appointment.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('recordComment', () => {
    it('acota el update por clinicId y appointmentId, y trunca a 1000', async () => {
      const ok = await service.recordComment('clinic-A', 'appt-1', `  ${'x'.repeat(1200)}  `);

      expect(ok).toBe(true);
      expect(prisma.feedback.updateMany).toHaveBeenCalledWith({
        where: { appointmentId: 'appt-1', clinicId: 'clinic-A' },
        data: { comment: 'x'.repeat(1000) },
      });
    });

    /**
     * `update` exige un `where` único y `appointmentId` lo es, así que no
     * admite el filtro por `clinicId`: con `update` a pelo, un appointmentId
     * cruzado sobrescribe el comentario del paciente de otra clínica.
     */
    it('cita de otra clínica: no actualiza nada y devuelve false', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const ok = await service.recordComment('clinic-B', 'appt-1', 'texto ajeno');

      expect(ok).toBe(false);
      expect(prisma.feedback.updateMany.mock.calls[0][0].where).toEqual({
        appointmentId: 'appt-1',
        clinicId: 'clinic-B',
      });
    });

    it('usa updateMany, nunca update (update lanza P2025 si no hay match)', async () => {
      await service.recordComment('clinic-A', 'appt-1', 'gracias');
      expect(prisma.feedback.update).not.toHaveBeenCalled();
      expect(prisma.feedback.updateMany).toHaveBeenCalled();
    });

    it('comentario en blanco se guarda como null, igual que en recordFeedback', async () => {
      await service.recordComment('clinic-A', 'appt-1', '   ');
      expect(prisma.feedback.updateMany.mock.calls[0][0].data.comment).toBeNull();
    });

    it('segunda respuesta (unique violation P2002) → created=false sin lanzar', async () => {
      const err = Object.assign(
        new Error('Unique constraint failed on the fields: (`appointmentId`)'),
        { code: 'P2002' },
      );
      prisma.feedback.create.mockRejectedValue(err);

      await expect(service.recordFeedback('clinic-A', 'appt-1', 3)).resolves.toEqual({
        created: false,
      });
    });

    it('otros errores de DB se propagan', async () => {
      prisma.feedback.create.mockRejectedValue(new Error('connection refused'));
      await expect(service.recordFeedback('clinic-A', 'appt-1', 3)).rejects.toThrow(
        'connection refused',
      );
    });
  });
});
