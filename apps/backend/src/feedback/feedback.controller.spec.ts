import { FeedbackController } from './feedback.controller';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/tenant-context.util';

/**
 * El controller no tenía spec, y es uno de los que más lo necesita: sirve
 * feedback de pacientes (PII de salud) y su aislamiento entre clínicas depende
 * enteramente de que el `where` esté bien puesto.
 *
 * Lo que se fija acá es que el tenant se exige **también sobre la cita**, no
 * solo sobre el feedback. Los `include` traen nombre de paciente, profesional y
 * servicio DE LA CITA: filtrar solo por `Feedback.clinicId` da por hecho que la
 * cita es del mismo tenant, y hasta la FK compuesta (ADR 0021) nada en la BD lo
 * garantizaba.
 */
describe('FeedbackController', () => {
  const USER = { userId: 'u-1', clinicId: 'clinic-A', role: 'CLINIC_ADMIN' } as AuthUser;

  function makeController(rows: any[] = []) {
    const prisma = {
      feedback: { findMany: jest.fn().mockResolvedValue(rows) },
    } as unknown as PrismaService & any;
    return { controller: new FeedbackController(prisma), prisma };
  }

  function makeRow(over: Record<string, unknown> = {}) {
    return {
      id: 'fb-1',
      score: 5,
      comment: null,
      respondedAt: new Date('2026-09-01T10:00:00Z'),
      appointmentId: 'appt-1',
      appointment: {
        startAt: new Date('2026-09-01T09:00:00Z'),
        patient: { name: 'Ana Pérez' },
        professional: { id: 'prof-1', name: 'Dra. Ríos' },
        service: { name: 'Consulta' },
      },
      ...over,
    };
  }

  describe('GET /feedback', () => {
    it('exige el tenant sobre el feedback Y sobre la cita', async () => {
      const { controller, prisma } = makeController();

      await controller.list(USER);

      const { where } = prisma.feedback.findMany.mock.calls[0][0];
      expect(where.clinicId).toBe('clinic-A');
      // Sin esto, una fila con el clinicId cruzado expondría por el `include`
      // el nombre del paciente, el profesional y el servicio de otra clínica.
      expect(where.appointment.is.clinicId).toBe('clinic-A');
    });

    it('el filtro por profesional no pisa el tenant de la cita', async () => {
      const { controller, prisma } = makeController();

      await controller.list(USER, 'prof-7');

      const { where } = prisma.feedback.findMany.mock.calls[0][0];
      expect(where.appointment.is).toEqual({
        clinicId: 'clinic-A',
        professionalId: 'prof-7',
      });
    });

    it('sin filtro de profesional no cuela un professionalId undefined', async () => {
      const { controller, prisma } = makeController();

      await controller.list(USER);

      const { where } = prisma.feedback.findMany.mock.calls[0][0];
      expect(where.appointment.is).not.toHaveProperty('professionalId');
    });

    it('mapea la fila a la forma que espera el panel', async () => {
      const { controller } = makeController([makeRow()]);

      const [item] = await controller.list(USER);

      expect(item).toMatchObject({
        id: 'fb-1',
        score: 5,
        appointmentId: 'appt-1',
        patientName: 'Ana Pérez',
        professionalId: 'prof-1',
        professionalName: 'Dra. Ríos',
        serviceName: 'Consulta',
      });
    });

    it('cap defensivo del limit a 200 y default 50', async () => {
      const { controller, prisma } = makeController();

      await controller.list(USER, undefined, '10000');
      expect(prisma.feedback.findMany.mock.calls[0][0].take).toBe(200);

      await controller.list(USER, undefined, undefined);
      expect(prisma.feedback.findMany.mock.calls[1][0].take).toBe(50);

      await controller.list(USER, undefined, 'no-es-un-numero');
      expect(prisma.feedback.findMany.mock.calls[2][0].take).toBe(50);
    });
  });

  describe('GET /feedback/summary', () => {
    it('exige el tenant sobre el feedback Y sobre la cita', async () => {
      const { controller, prisma } = makeController();

      await controller.summary(USER);

      const { where } = prisma.feedback.findMany.mock.calls[0][0];
      expect(where.clinicId).toBe('clinic-A');
      expect(where.appointment.is.clinicId).toBe('clinic-A');
    });

    it('agrega count, media y distribución', async () => {
      const { controller } = makeController([
        makeRow({ id: 'a', score: 5 }),
        makeRow({ id: 'b', score: 3 }),
      ]);

      const res = await controller.summary(USER);

      expect(res.count).toBe(2);
      expect(res.average).toBe(4);
      expect(res.distribution['5']).toBe(1);
      expect(res.distribution['3']).toBe(1);
      expect(res.distribution['1']).toBe(0);
    });

    it('sin respuestas devuelve media 0 y todos los buckets a 0', async () => {
      const { controller } = makeController([]);

      const res = await controller.summary(USER);

      expect(res.count).toBe(0);
      expect(res.average).toBe(0);
      expect(res.byProfessional).toEqual([]);
      expect(Object.values(res.distribution)).toEqual([0, 0, 0, 0, 0]);
    });

    it('agrupa por profesional', async () => {
      const { controller } = makeController([
        makeRow({ id: 'a', score: 5 }),
        makeRow({
          id: 'b',
          score: 1,
          appointment: {
            startAt: new Date(),
            patient: { name: 'B' },
            professional: { id: 'prof-2', name: 'Dr. Paredes' },
            service: { name: 'Consulta' },
          },
        }),
      ]);

      const res = await controller.summary(USER);

      const ids = res.byProfessional.map((p) => p.professionalId);
      expect(ids).toContain('prof-1');
      expect(ids).toContain('prof-2');
    });
  });
});
