import { PrismaService } from '../prisma/prisma.service';
import { ClinicFactsService } from './clinic-facts.service';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

const BASE_CLINIC = {
  name: 'Clínica Demo',
  address: null as string | null,
  publicWhatsappPhone: null as string | null,
  currency: 'USD',
  timezone: 'America/Caracas',
  locale: 'es',
};

/** Redis mock en memoria — get/set alcanza para lo que usa el service. */
function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    _store: store,
  };
}

describe('ClinicFactsService', () => {
  let prisma: Deep<PrismaService>;
  let redis: ReturnType<typeof makeRedisMock>;
  let svc: ClinicFactsService;

  beforeEach(() => {
    prisma = {
      clinic: { findUnique: jest.fn() },
      businessHour: { findMany: jest.fn().mockResolvedValue([]) },
      service: { findMany: jest.fn().mockResolvedValue([]) },
      professional: { findMany: jest.fn().mockResolvedValue([]) },
      patient: { findUnique: jest.fn().mockResolvedValue(null) },
      appointment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    redis = makeRedisMock();
    svc = new ClinicFactsService(
      prisma as unknown as PrismaService,
      redis as any,
    );
  });

  it('devuelve string vacío si la clínica no existe', async () => {
    prisma.clinic.findUnique.mockResolvedValueOnce(null);
    const result = await svc.build('clinic-inexistente');
    expect(result).toBe('');
  });

  it('arma nombre, dirección y WhatsApp sólo si existen', async () => {
    prisma.clinic.findUnique.mockResolvedValueOnce({
      ...BASE_CLINIC,
      address: 'Av. Principal 123',
      publicWhatsappPhone: '+584121234567',
    });

    const result = await svc.build('clinic-A');

    expect(result).toContain('Clínica: Clínica Demo');
    expect(result).toContain('Dirección: Av. Principal 123');
    expect(result).toContain('WhatsApp: +584121234567');
  });

  it('omite dirección y WhatsApp cuando son null', async () => {
    prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });

    const result = await svc.build('clinic-A');

    expect(result).not.toMatch(/Dirección:/);
    expect(result).not.toMatch(/WhatsApp:/);
  });

  describe('horario', () => {
    it('sin filas de BusinessHour: "Horario: no informado"', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.businessHour.findMany.mockResolvedValueOnce([]);

      const result = await svc.build('clinic-A');

      expect(result).toContain('Horario: no informado');
    });

    it('agrupa días consecutivos con el mismo rango (lunes a viernes + sábado distinto)', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      const weekdayRange = (weekday: number, start: number, end: number) => ({
        id: `bh-${weekday}`,
        clinicId: 'clinic-A',
        professionalId: null,
        weekday,
        startMinutes: start,
        endMinutes: end,
      });
      prisma.businessHour.findMany.mockResolvedValueOnce([
        weekdayRange(1, 480, 1020), // lunes 8:00-17:00
        weekdayRange(2, 480, 1020),
        weekdayRange(3, 480, 1020),
        weekdayRange(4, 480, 1020),
        weekdayRange(5, 480, 1020), // viernes 8:00-17:00
        weekdayRange(6, 540, 780), // sábado 9:00-13:00
      ]);

      const result = await svc.build('clinic-A');

      expect(result).toContain(
        'Horario de atención: Lunes a viernes 8:00 a 17:00. Sábado 9:00 a 13:00.',
      );
    });

    it('días sin filas se omiten (no se listan como cerrado)', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.businessHour.findMany.mockResolvedValueOnce([
        {
          id: 'bh-6',
          clinicId: 'clinic-A',
          professionalId: null,
          weekday: 6,
          startMinutes: 540,
          endMinutes: 780,
        },
      ]);

      const result = await svc.build('clinic-A');

      expect(result).toContain('Horario de atención: Sábado 9:00 a 13:00.');
      expect(result).not.toMatch(/domingo|lunes|martes/i);
    });

    it('NO fusiona días separados por un día cerrado, aunque el rango coincida', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      const weekdayRange = (weekday: number, start: number, end: number) => ({
        id: `bh-${weekday}`,
        clinicId: 'clinic-A',
        professionalId: null,
        weekday,
        startMinutes: start,
        endMinutes: end,
      });
      // Lunes 9-13, MARTES CERRADO (sin fila), miércoles a viernes 9-13.
      prisma.businessHour.findMany.mockResolvedValueOnce([
        weekdayRange(1, 540, 780),
        weekdayRange(3, 540, 780),
        weekdayRange(4, 540, 780),
        weekdayRange(5, 540, 780),
      ]);

      const result = await svc.build('clinic-A');

      // Nunca debe decir "Lunes a viernes" (implicaría martes abierto).
      expect(result).not.toMatch(/Lunes a viernes/);
      expect(result).toContain(
        'Horario de atención: Lunes 9:00 a 13:00. Miércoles a viernes 9:00 a 13:00.',
      );
    });

    it('soporta turno partido el mismo día (varias filas)', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.businessHour.findMany.mockResolvedValueOnce([
        {
          id: 'bh-1a',
          clinicId: 'clinic-A',
          professionalId: null,
          weekday: 1,
          startMinutes: 540,
          endMinutes: 780,
        },
        {
          id: 'bh-1b',
          clinicId: 'clinic-A',
          professionalId: null,
          weekday: 1,
          startMinutes: 900,
          endMinutes: 1080,
        },
      ]);

      const result = await svc.build('clinic-A');

      expect(result).toContain(
        'Horario de atención: Lunes 9:00 a 13:00 y 15:00 a 18:00.',
      );
    });

    it('sólo usa BusinessHour de la clínica (professionalId null), no de profesionales', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      await svc.build('clinic-A');

      expect(prisma.businessHour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clinicId: 'clinic-A', professionalId: null },
        }),
      );
    });
  });

  describe('servicios', () => {
    it('precio con currency cuando priceCents no es null', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.service.findMany.mockResolvedValueOnce([
        {
          id: 's1',
          clinicId: 'clinic-A',
          name: 'Limpieza dental',
          durationMin: 30,
          bufferMin: 0,
          priceCents: 2000,
          active: true,
          createdAt: new Date(),
        },
      ]);

      const result = await svc.build('clinic-A');

      expect(result).toContain('Limpieza dental (30 min) - USD 20.00');
    });

    it('nunca inventa un precio: priceCents null → "precio a consultar"', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.service.findMany.mockResolvedValueOnce([
        {
          id: 's1',
          clinicId: 'clinic-A',
          name: 'Ortodoncia',
          durationMin: 45,
          bufferMin: 0,
          priceCents: null,
          active: true,
          createdAt: new Date(),
        },
      ]);

      const result = await svc.build('clinic-A');

      expect(result).toContain('Ortodoncia (45 min) - precio a consultar');
      expect(result).not.toMatch(/Ortodoncia.*USD/);
    });

    it('sólo trae servicios activos', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      await svc.build('clinic-A');

      expect(prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clinicId: 'clinic-A', active: true },
        }),
      );
    });
  });

  describe('profesionales', () => {
    it('nombre, especialidad y servicios que atiende', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.professional.findMany.mockResolvedValueOnce([
        {
          name: 'Dra. Fernanda',
          specialty: 'Odontología',
          services: [{ name: 'Limpieza dental' }, { name: 'Ortodoncia' }],
        },
      ]);

      const result = await svc.build('clinic-A');

      expect(result).toContain(
        '- Dra. Fernanda (Odontología): atiende Limpieza dental, Ortodoncia.',
      );
    });

    it('sin especialidad: no muestra paréntesis vacíos', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.professional.findMany.mockResolvedValueOnce([
        { name: 'Dr. Pérez', specialty: null, services: [{ name: 'Consulta' }] },
      ]);

      const result = await svc.build('clinic-A');

      expect(result).toContain('- Dr. Pérez: atiende Consulta.');
    });
  });

  describe('tope de caracteres', () => {
    it('recorta profesionales/servicios con "…y N más" si se pasa de ~2000 caracteres', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      const manyServices = Array.from({ length: 60 }, (_, i) => ({
        id: `s${i}`,
        clinicId: 'clinic-A',
        name: `Servicio con nombre bastante largo número ${i}`,
        durationMin: 30,
        bufferMin: 0,
        priceCents: 1000,
        active: true,
        createdAt: new Date(),
      }));
      const manyProfessionals = Array.from({ length: 40 }, (_, i) => ({
        name: `Profesional con nombre largo número ${i}`,
        specialty: 'Especialidad genérica de prueba',
        services: [{ name: 'Servicio X' }],
      }));
      prisma.service.findMany.mockResolvedValueOnce(manyServices);
      prisma.professional.findMany.mockResolvedValueOnce(manyProfessionals);

      const result = await svc.build('clinic-A');

      expect(result.length).toBeLessThanOrEqual(2000);
      expect(result).toMatch(/…y \d+ más\./);
    });
  });

  describe('cache Redis (60s, sólo la parte sin paciente)', () => {
    it('cachea el bloque base y no vuelve a golpear la DB en la segunda llamada', async () => {
      prisma.clinic.findUnique.mockResolvedValue({ ...BASE_CLINIC });

      await svc.build('clinic-A');
      await svc.build('clinic-A');

      expect(prisma.businessHour.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.service.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.professional.findMany).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledTimes(1);
    });

    it('si Redis GET falla, calcula de DB igual (fail-open) sin tirar', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      redis.get.mockRejectedValueOnce(new Error('redis down'));

      const result = await svc.build('clinic-A');

      expect(result).toContain('Clínica: Clínica Demo');
    });

    it('la línea de próxima cita NUNCA se cachea (se recalcula por-paciente)', async () => {
      prisma.clinic.findUnique.mockResolvedValue({ ...BASE_CLINIC });
      prisma.patient.findUnique.mockResolvedValue({
        id: 'pat-1',
        clinicId: 'clinic-A',
        phone: '+584121234567',
      });
      prisma.appointment.findFirst.mockResolvedValue({
        id: 'appt-1',
        startAt: new Date('2026-09-20T13:00:00.000Z'),
        status: 'CONFIRMADA',
        service: { name: 'Limpieza' },
        professional: { name: 'Dra. Fernanda' },
      });

      await svc.build('clinic-A', '+584121234567');
      await svc.build('clinic-A', '+584121234567');

      // El bloque base se cachea (1 sola consulta a professional/service/businessHour)…
      expect(prisma.service.findMany).toHaveBeenCalledTimes(1);
      // …pero la cita se recalcula en cada llamada.
      expect(prisma.appointment.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe('próxima cita del paciente (multi-tenant)', () => {
    it('sin phone: no consulta Patient ni Appointment', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });

      await svc.build('clinic-A');

      expect(prisma.patient.findUnique).not.toHaveBeenCalled();
      expect(prisma.appointment.findFirst).not.toHaveBeenCalled();
    });

    it('phone sin Patient en esa clínica: no agrega línea de cita', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.patient.findUnique.mockResolvedValueOnce(null);

      const result = await svc.build('clinic-A', '+584121234567');

      expect(result).not.toMatch(/Próxima cita/);
    });

    it('agrega servicio, profesional, fecha (TZ/locale de la clínica) y estado en palabras', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.patient.findUnique.mockResolvedValueOnce({
        id: 'pat-1',
        clinicId: 'clinic-A',
        phone: '+584121234567',
      });
      prisma.appointment.findFirst.mockResolvedValueOnce({
        id: 'appt-1',
        startAt: new Date('2026-09-20T13:00:00.000Z'), // 09:00 America/Caracas (UTC-4)
        status: 'CONFIRMADA',
        service: { name: 'Limpieza dental' },
        professional: { name: 'Dra. Fernanda' },
      });

      const result = await svc.build('clinic-A', '+584121234567');

      expect(result).toMatch(
        /Próxima cita de este número: Limpieza dental con Dra\. Fernanda el .*confirmada/,
      );
      expect(result).toContain('9:00'); // hora local Caracas
    });

    it('busca el Patient/Appointment SOLO en la clínica dada (filtra clinicId)', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.patient.findUnique.mockResolvedValueOnce(null);

      await svc.build('clinic-A', '+584121234567');

      expect(prisma.patient.findUnique).toHaveBeenCalledWith({
        where: {
          clinicId_phone: { clinicId: 'clinic-A', phone: '+584121234567' },
        },
      });
    });

    it('nunca expone el nombre del paciente ni otros datos, sólo la cita', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.patient.findUnique.mockResolvedValueOnce({
        id: 'pat-1',
        clinicId: 'clinic-A',
        phone: '+584121234567',
        name: 'Juan Pérez Secreto',
      });
      prisma.appointment.findFirst.mockResolvedValueOnce({
        id: 'appt-1',
        startAt: new Date('2026-09-20T13:00:00.000Z'),
        status: 'PENDIENTE',
        service: { name: 'Consulta' },
        professional: { name: 'Dr. Gómez' },
      });

      const result = await svc.build('clinic-A', '+584121234567');

      expect(result).not.toContain('Juan Pérez Secreto');
    });

    it('sólo considera citas activas (PENDIENTE/EN_RIESGO/CONFIRMADA), futuras', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({ ...BASE_CLINIC });
      prisma.patient.findUnique.mockResolvedValueOnce({
        id: 'pat-1',
        clinicId: 'clinic-A',
        phone: '+584121234567',
      });

      await svc.build('clinic-A', '+584121234567');

      expect(prisma.appointment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            clinicId: 'clinic-A',
            patientId: 'pat-1',
            status: { in: ['PENDIENTE', 'EN_RIESGO', 'CONFIRMADA'] },
          }),
        }),
      );
    });
  });
});
