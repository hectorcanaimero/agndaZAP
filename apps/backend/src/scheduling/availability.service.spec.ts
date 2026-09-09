import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService } from './availability.service';

/**
 * Tests de regresión del motor de disponibilidad.
 *
 * F2.1.T1 (P0): el motor devolvía la UNIÓN del horario del profesional con el
 * de la clínica en vez del override. Un profesional con horario propio recibía
 * slots del horario de la clínica en las mismas franjas. Este suite fija el
 * contrato: si el profesional tiene *cualquier* BusinessHour propio, el
 * horario de la clínica se ignora por completo para ese profesional.
 */
describe('AvailabilityService', () => {
  const timezone = 'America/Caracas';
  const clinicId = 'clinic-A';
  const serviceId = 'svc-1';
  const professionalId = 'prof-1';

  function makeService(overrides: Partial<{ durationMin: number; bufferMin: number }> = {}) {
    return {
      id: serviceId,
      clinicId,
      durationMin: 60,
      bufferMin: 0,
      ...overrides,
    };
  }

  function makeClinic() {
    return { id: clinicId, timezone };
  }

  // Un lunes lejano en el futuro (evita el filtro `inPast`).
  const monday2099 = '2099-01-05'; // 2099-01-05 fue un lunes.

  function makePrisma(overrides: {
    businessHours: Array<{
      weekday: number;
      startMinutes: number;
      endMinutes: number;
      professionalId: string | null;
    }>;
    service?: ReturnType<typeof makeService>;
    appointments?: Array<{
      startAt: Date;
      endAt: Date;
      service: { bufferMin: number };
    }>;
  }) {
    return {
      clinic: { findUniqueOrThrow: jest.fn().mockResolvedValue(makeClinic()) },
      service: {
        findFirstOrThrow: jest
          .fn()
          .mockResolvedValue(overrides.service ?? makeService()),
      },
      businessHour: {
        findMany: jest.fn().mockResolvedValue(overrides.businessHours),
      },
      timeOff: { findMany: jest.fn().mockResolvedValue([]) },
      appointment: {
        findMany: jest.fn().mockResolvedValue(overrides.appointments ?? []),
      },
    } as unknown as PrismaService;
  }

  it('override: profesional con horario propio NO hereda el de la clínica en la misma franja', async () => {
    // Clínica lunes 9-18 (9 slots de 1h). Profesional lunes 14-18 (4 slots).
    // Antes del fix: se generaban 13 slots (unión, con duplicados removidos por
    // el step). Después del fix: sólo 4 (14, 15, 16, 17).
    const prisma = makePrisma({
      businessHours: [
        // Clínica lunes 09:00-18:00.
        {
          weekday: 1,
          startMinutes: 9 * 60,
          endMinutes: 18 * 60,
          professionalId: null,
        },
        // Profesional lunes 14:00-18:00 (override).
        {
          weekday: 1,
          startMinutes: 14 * 60,
          endMinutes: 18 * 60,
          professionalId,
        },
      ],
    });

    const availability = new AvailabilityService(prisma);
    const slots = await availability.getSlots({
      clinicId,
      serviceId,
      professionalId,
      fromISO: monday2099,
      days: 1,
      limit: 50,
    });

    expect(slots).toHaveLength(4);
    const startHours = slots.map((s) => s.startAt.getUTCHours());
    // Zona -04:00 (Caracas): 14:00 local = 18 UTC, 17:00 local = 21 UTC.
    expect(startHours).toEqual([18, 19, 20, 21]);
  });

  it('override: profesional con horario propio en OTRO día no hereda clínica del día sin propio', async () => {
    // El fix es "si el profesional tiene cualquier BusinessHour propio,
    // descartamos todos los de la clínica" — no un override por weekday.
    // Profesional trabaja SÓLO martes 10-12. Clínica abre lun-mar 09-18.
    // El lunes el profesional NO atiende (no hereda el horario clínica).
    const prisma = makePrisma({
      businessHours: [
        // Clínica lunes 09-18.
        {
          weekday: 1,
          startMinutes: 9 * 60,
          endMinutes: 18 * 60,
          professionalId: null,
        },
        // Clínica martes 09-18.
        {
          weekday: 2,
          startMinutes: 9 * 60,
          endMinutes: 18 * 60,
          professionalId: null,
        },
        // Profesional SÓLO martes 10-12 (2 slots).
        {
          weekday: 2,
          startMinutes: 10 * 60,
          endMinutes: 12 * 60,
          professionalId,
        },
      ],
    });

    const availability = new AvailabilityService(prisma);
    const slots = await availability.getSlots({
      clinicId,
      serviceId,
      professionalId,
      fromISO: monday2099, // arranca el lunes; mira lun + mar.
      days: 2,
      limit: 50,
    });

    // Sólo martes 10:00 y 11:00. Lunes: cero (no hereda).
    expect(slots).toHaveLength(2);
    for (const s of slots) {
      // martes = 2099-01-06.
      expect(s.startAt.toISOString().slice(0, 10)).toBe('2099-01-06');
    }
  });

  it('fallback: profesional SIN horario propio hereda el de la clínica', async () => {
    const prisma = makePrisma({
      businessHours: [
        {
          weekday: 1,
          startMinutes: 9 * 60,
          endMinutes: 12 * 60,
          professionalId: null,
        },
      ],
    });

    const availability = new AvailabilityService(prisma);
    const slots = await availability.getSlots({
      clinicId,
      serviceId,
      professionalId,
      fromISO: monday2099,
      days: 1,
      limit: 50,
    });

    // 3 slots de 1h: 9, 10, 11.
    expect(slots).toHaveLength(3);
  });

  describe('bufferMin de citas ocupadas', () => {
    it('no ofrece el slot pegado a una cita con buffer; sí el siguiente', async () => {
      // Servicio de 15 min sin buffer propio; horario lunes 10:00-12:00.
      // Cita existente 10:00-10:30 (local, -04:00) con bufferMin=15 →
      // ocupado hasta 10:45. El slot 10:30 NO se ofrece; 10:45 sí.
      const prisma = makePrisma({
        businessHours: [
          {
            weekday: 1,
            startMinutes: 10 * 60,
            endMinutes: 12 * 60,
            professionalId: null,
          },
        ],
        service: makeService({ durationMin: 15, bufferMin: 0 }),
        appointments: [
          {
            startAt: new Date('2099-01-05T14:00:00Z'), // 10:00 Caracas
            endAt: new Date('2099-01-05T14:30:00Z'), // 10:30 Caracas
            service: { bufferMin: 15 },
          },
        ],
      });

      const availability = new AvailabilityService(prisma);
      const slots = await availability.getSlots({
        clinicId,
        serviceId,
        professionalId,
        fromISO: monday2099,
        days: 1,
        limit: 50,
      });

      const startsUtc = slots.map((s) => s.startAt.toISOString());
      expect(startsUtc).not.toContain('2099-01-05T14:00:00.000Z'); // 10:00
      expect(startsUtc).not.toContain('2099-01-05T14:15:00.000Z'); // 10:15
      expect(startsUtc).not.toContain('2099-01-05T14:30:00.000Z'); // 10:30 (buffer)
      expect(startsUtc).toContain('2099-01-05T14:45:00.000Z'); // 10:45
    });

    it('el buffer del servicio nuevo también cuenta: no se pega ANTES de una cita', async () => {
      // Cita existente 10:30-11:00 sin buffer. Servicio nuevo 15 min con
      // bufferMin=15 → step 30. Slot 10:00 (10:00-10:15 + buffer → 10:30) OK;
      // slot 10:30 pisa la cita. Con step 30 el candidato 10:15 no existe,
      // así que probamos también con un servicio de 15+15 arrancando a 10:15
      // vía horario 10:15-12:00: 10:15-10:30 + buffer 15 → 10:45 pisa 10:30.
      const appointments = [
        {
          startAt: new Date('2099-01-05T14:30:00Z'), // 10:30 Caracas
          endAt: new Date('2099-01-05T15:00:00Z'), // 11:00 Caracas
          service: { bufferMin: 0 },
        },
      ];
      const service = makeService({ durationMin: 15, bufferMin: 15 });

      const fromTen = new AvailabilityService(
        makePrisma({
          businessHours: [
            { weekday: 1, startMinutes: 10 * 60, endMinutes: 12 * 60, professionalId: null },
          ],
          service,
          appointments,
        }),
      );
      const slotsTen = (
        await fromTen.getSlots({ clinicId, serviceId, professionalId, fromISO: monday2099, days: 1, limit: 50 })
      ).map((s) => s.startAt.toISOString());
      expect(slotsTen).toContain('2099-01-05T14:00:00.000Z'); // 10:00 sí

      const fromQuarter = new AvailabilityService(
        makePrisma({
          businessHours: [
            { weekday: 1, startMinutes: 10 * 60 + 15, endMinutes: 12 * 60, professionalId: null },
          ],
          service,
          appointments,
        }),
      );
      const slotsQuarter = (
        await fromQuarter.getSlots({ clinicId, serviceId, professionalId, fromISO: monday2099, days: 1, limit: 50 })
      ).map((s) => s.startAt.toISOString());
      expect(slotsQuarter).not.toContain('2099-01-05T14:15:00.000Z'); // 10:15 no
      expect(slotsQuarter).toContain('2099-01-05T15:15:00.000Z'); // 11:15 sí (tras la cita)
    });

    it('filtra citas ocupadas por clinicId además de professionalId', async () => {
      const prisma = makePrisma({ businessHours: [] });
      await new AvailabilityService(prisma).getSlots({
        clinicId,
        serviceId,
        professionalId,
        fromISO: monday2099,
        days: 1,
      });
      expect(
        (prisma.appointment.findMany as jest.Mock).mock.calls[0][0].where,
      ).toEqual(expect.objectContaining({ clinicId, professionalId }));
      expect(
        (prisma.service.findFirstOrThrow as jest.Mock).mock.calls[0][0].where,
      ).toEqual({ id: serviceId, clinicId });
    });
  });
});
