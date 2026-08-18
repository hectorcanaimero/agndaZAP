import { PrismaService } from '../prisma/prisma.service';
import { AdminMetricsService } from './admin-metrics.service';

// ─── tipos de stub ────────────────────────────────────────────────────────

type PrismaStub = {
  clinic: { groupBy: jest.Mock; findMany: jest.Mock };
  appointment: { groupBy: jest.Mock };
};

// ─── factories ────────────────────────────────────────────────────────────

const makeClinicGroups = (overrides: Partial<Record<string, number>> = {}) => {
  const defaults = { ACTIVE: 10, SUSPENDED: 2, ARCHIVED: 1 };
  const merged = { ...defaults, ...overrides };
  return Object.entries(merged).map(([status, count]) => ({
    status,
    _count: { _all: count },
  }));
};

/** Grupos de citas por status, para el groupBy cross-tenant. */
const makeApptGroups = (overrides: Partial<Record<string, number>> = {}) => {
  const defaults = {
    ATENDIDA: 80,
    NO_SHOW: 20,
    CANCELADA: 10,
    PENDIENTE: 5,
    CONFIRMADA: 15,
    EN_RIESGO: 3,
  };
  const merged = { ...defaults, ...overrides };
  return Object.entries(merged).map(([status, count]) => ({
    status,
    _count: { _all: count },
  }));
};

/** Grupos de citas por clinicId, para topClinics. */
const makeTopGroups = () => [
  { clinicId: 'c-1', _count: { _all: 50 } },
  { clinicId: 'c-2', _count: { _all: 40 } },
  { clinicId: 'c-3', _count: { _all: 30 } },
  { clinicId: 'c-4', _count: { _all: 20 } },
  { clinicId: 'c-5', _count: { _all: 10 } },
];

const makeClinicRecords = (ids: string[]) =>
  ids.map((id, i) => ({ id, name: `Clínica ${i + 1}`, slug: `clinica-${i + 1}` }));

// ─── tests ────────────────────────────────────────────────────────────────

describe('AdminMetricsService.getOverview', () => {
  let prismaStub: PrismaStub;
  let service: AdminMetricsService;

  const setupDefault = () => {
    const topGroups = makeTopGroups();
    prismaStub = {
      clinic: {
        groupBy: jest.fn().mockResolvedValue(makeClinicGroups()),
        findMany: jest
          .fn()
          .mockResolvedValue(makeClinicRecords(topGroups.map((g) => g.clinicId))),
      },
      appointment: {
        groupBy: jest
          .fn()
          .mockResolvedValueOnce(makeApptGroups()) // primera llamada → byStatus
          .mockResolvedValueOnce(topGroups),       // segunda llamada → topClinics
      },
    };
    service = new AdminMetricsService(prismaStub as unknown as PrismaService);
  };

  beforeEach(setupDefault);

  // ── clinics breakdown ──────────────────────────────────────────────────

  it('devuelve el desglose correcto de clínicas por status', async () => {
    const result = await service.getOverview();

    expect(result.clinics).toEqual({
      active: 10,
      suspended: 2,
      archived: 1,
      total: 13,
    });
  });

  it('total = active + suspended + archived', async () => {
    const result = await service.getOverview();
    const { active, suspended, archived, total } = result.clinics;
    expect(total).toBe(active + suspended + archived);
  });

  it('maneja status ausentes con 0 (ej. sin clínicas ARCHIVED)', async () => {
    prismaStub.clinic.groupBy.mockResolvedValue(makeClinicGroups({ ARCHIVED: 0 }));
    const result = await service.getOverview();
    expect(result.clinics.archived).toBe(0);
  });

  // ── appointmentsLast30d ────────────────────────────────────────────────

  it('appointmentsLast30d es la suma de todos los status del período', async () => {
    const result = await service.getOverview();
    // defaults: 80+20+10+5+15+3 = 133
    expect(result.appointmentsLast30d).toBe(133);
  });

  // ── noShowRate ────────────────────────────────────────────────────────

  it('calcula noShowRateLast30d correctamente (NO_SHOW / terminales)', async () => {
    // Terminales = ATENDIDA(80) + NO_SHOW(20) + CANCELADA(10) = 110
    // Ratio = 20 / 110 ≈ 0.1818...
    const result = await service.getOverview();
    expect(result.noShowRateLast30d).toBeCloseTo(20 / 110, 5);
  });

  it('noShowRateLast30d = 0 cuando denominator es 0 (sin citas terminales)', async () => {
    prismaStub.appointment.groupBy
      .mockReset()
      .mockResolvedValueOnce([
        { status: 'PENDIENTE', _count: { _all: 5 } },
        { status: 'CONFIRMADA', _count: { _all: 3 } },
      ])
      .mockResolvedValueOnce([]);

    const result = await service.getOverview();
    expect(result.noShowRateLast30d).toBe(0);
  });

  it('noShowRateLast30d = 0 cuando no hay NO_SHOW (todos ATENDIDA)', async () => {
    prismaStub.appointment.groupBy
      .mockReset()
      .mockResolvedValueOnce([{ status: 'ATENDIDA', _count: { _all: 50 } }])
      .mockResolvedValueOnce([]);

    const result = await service.getOverview();
    expect(result.noShowRateLast30d).toBe(0);
  });

  it('noShowRateLast30d = 1 cuando todas las terminales son NO_SHOW', async () => {
    prismaStub.appointment.groupBy
      .mockReset()
      .mockResolvedValueOnce([{ status: 'NO_SHOW', _count: { _all: 30 } }])
      .mockResolvedValueOnce([]);

    const result = await service.getOverview();
    expect(result.noShowRateLast30d).toBe(1);
  });

  // ── topClinics ────────────────────────────────────────────────────────

  it('devuelve exactamente 5 clínicas en topClinics', async () => {
    const result = await service.getOverview();
    expect(result.topClinics).toHaveLength(5);
  });

  it('topClinics está ordenado por appointmentCount desc', async () => {
    const result = await service.getOverview();
    const counts = result.topClinics.map((c) => c.appointmentCount);
    for (let i = 0; i < counts.length - 1; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i + 1]);
    }
  });

  it('topClinics incluye id, name, slug y appointmentCount', async () => {
    const result = await service.getOverview();
    for (const c of result.topClinics) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('name');
      expect(c).toHaveProperty('slug');
      expect(c).toHaveProperty('appointmentCount');
    }
  });

  it('merge correcto: appointmentCount viene del groupBy, no del findMany', async () => {
    const result = await service.getOverview();
    // El top grupo c-1 tiene 50 citas, c-5 tiene 10
    const top1 = result.topClinics.find((c) => c.id === 'c-1');
    const top5 = result.topClinics.find((c) => c.id === 'c-5');
    expect(top1?.appointmentCount).toBe(50);
    expect(top5?.appointmentCount).toBe(10);
  });

  it('omite clínicas del top cuyo registro no existe en DB (orphan clinicId)', async () => {
    // Sólo retorna 4 de los 5 IDs del topGroups.
    prismaStub.clinic.findMany.mockResolvedValue(
      makeClinicRecords(['c-1', 'c-2', 'c-3', 'c-4']),
    );

    const result = await service.getOverview();
    expect(result.topClinics).toHaveLength(4);
    expect(result.topClinics.every((c) => c.id !== 'c-5')).toBe(true);
  });

  it('topClinics vacío cuando no hay citas en el período', async () => {
    prismaStub.appointment.groupBy
      .mockReset()
      .mockResolvedValueOnce([])  // byStatus
      .mockResolvedValueOnce([]); // topGroups vacío

    prismaStub.clinic.findMany.mockResolvedValue([]);

    const result = await service.getOverview();
    expect(result.topClinics).toHaveLength(0);
    expect(result.appointmentsLast30d).toBe(0);
  });
});
