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

  function makeService() {
    return {
      id: serviceId,
      clinicId,
      durationMin: 60,
      bufferMin: 0,
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
  }) {
    return {
      clinic: { findUniqueOrThrow: jest.fn().mockResolvedValue(makeClinic()) },
      service: { findUniqueOrThrow: jest.fn().mockResolvedValue(makeService()) },
      businessHour: {
        findMany: jest.fn().mockResolvedValue(overrides.businessHours),
      },
      timeOff: { findMany: jest.fn().mockResolvedValue([]) },
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
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
});
