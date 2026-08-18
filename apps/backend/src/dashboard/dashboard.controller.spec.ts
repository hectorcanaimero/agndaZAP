import { DateTime } from 'luxon';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardController } from './dashboard.controller';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

describe('DashboardController', () => {
  let prisma: Deep<PrismaService>;
  let controller: DashboardController;
  let tz: string;
  let now: DateTime;

  const adminA: AuthUser = {
    userId: 'u',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };
  const superadmin: AuthUser = {
    userId: 'u-s',
    clinicId: null,
    role: 'SUPERADMIN',
  };
  // Post-ADR 0014: SUPERADMIN debe impersonar antes de operar sobre datos de
  // clínica. El JWT impersonado trae clinicId + impersonatedBy.
  const superadminImpersonatingZ: AuthUser = {
    userId: 'u-s',
    clinicId: 'clinic-Z',
    role: 'SUPERADMIN',
    impersonatedBy: 'u-s',
  };

  // Seed 60d (current 30d + previous 30d) — cubre byStatus, deltas,
  // topServices, topProfessionals, heatmap, sparklines, activePatients.
  function buildSeed60() {
    const yesterday = now.minus({ days: 1 });
    const twoDaysAgo = now.minus({ days: 2 });
    const fortyDaysAgo = now.minus({ days: 40 });
    return [
      // ── Current 30d ──
      {
        id: 'a1',
        status: 'ATENDIDA',
        startAt: yesterday.toJSDate(),
        endAt: yesterday.plus({ minutes: 30 }).toJSDate(),
        confirmedAt: yesterday.minus({ hours: 3 }).toJSDate(),
        patientId: 'p1',
        serviceId: 's1',
        service: { name: 'Consulta', priceCents: 5000 },
        professionalId: 'pr1',
        professional: { name: 'Dra. Ana', color: '#3b82f6' },
      },
      {
        id: 'a2',
        status: 'ATENDIDA',
        startAt: yesterday.toJSDate(),
        endAt: yesterday.plus({ minutes: 30 }).toJSDate(),
        confirmedAt: yesterday.minus({ hours: 3 }).toJSDate(),
        patientId: 'p2',
        serviceId: 's1',
        service: { name: 'Consulta', priceCents: 5000 },
        professionalId: 'pr1',
        professional: { name: 'Dra. Ana', color: '#3b82f6' },
      },
      {
        id: 'a3',
        status: 'ATENDIDA',
        startAt: yesterday.toJSDate(),
        endAt: yesterday.plus({ minutes: 30 }).toJSDate(),
        confirmedAt: null,
        patientId: 'p3',
        serviceId: 's2',
        service: { name: 'Limpieza', priceCents: 3000 },
        professionalId: 'pr2',
        professional: { name: 'Dr. Beto', color: '#10b981' },
      },
      {
        id: 'a4',
        status: 'NO_SHOW',
        startAt: yesterday.toJSDate(),
        endAt: yesterday.plus({ minutes: 30 }).toJSDate(),
        confirmedAt: null,
        patientId: 'p1', // repeated patient → activePatients cuenta único
        serviceId: 's1',
        service: { name: 'Consulta', priceCents: 5000 },
        professionalId: 'pr1',
        professional: { name: 'Dra. Ana', color: '#3b82f6' },
      },
      {
        id: 'a5',
        status: 'CONFIRMADA',
        startAt: twoDaysAgo.toJSDate(),
        endAt: twoDaysAgo.plus({ minutes: 30 }).toJSDate(),
        confirmedAt: twoDaysAgo.minus({ hours: 2 }).toJSDate(),
        patientId: 'p4',
        serviceId: 's2',
        service: { name: 'Limpieza', priceCents: 3000 },
        professionalId: 'pr2',
        professional: { name: 'Dr. Beto', color: '#10b981' },
      },
      {
        id: 'a6',
        status: 'CANCELADA',
        startAt: yesterday.toJSDate(),
        endAt: yesterday.plus({ minutes: 30 }).toJSDate(),
        confirmedAt: null,
        patientId: 'p5',
        serviceId: 's1',
        service: { name: 'Consulta', priceCents: 5000 },
        professionalId: 'pr1',
        professional: { name: 'Dra. Ana', color: '#3b82f6' },
      },
      // ── Previous 30d (para deltas) ──
      {
        id: 'a7',
        status: 'ATENDIDA',
        startAt: fortyDaysAgo.toJSDate(),
        endAt: fortyDaysAgo.plus({ minutes: 30 }).toJSDate(),
        confirmedAt: fortyDaysAgo.minus({ hours: 3 }).toJSDate(),
        patientId: 'p6',
        serviceId: 's1',
        service: { name: 'Consulta', priceCents: 5000 },
        professionalId: 'pr1',
        professional: { name: 'Dra. Ana', color: '#3b82f6' },
      },
      {
        id: 'a8',
        status: 'ATENDIDA',
        startAt: fortyDaysAgo.toJSDate(),
        endAt: fortyDaysAgo.plus({ minutes: 30 }).toJSDate(),
        confirmedAt: fortyDaysAgo.minus({ hours: 3 }).toJSDate(),
        patientId: 'p6',
        serviceId: 's1',
        service: { name: 'Consulta', priceCents: 5000 },
        professionalId: 'pr1',
        professional: { name: 'Dra. Ana', color: '#3b82f6' },
      },
    ];
  }

  beforeEach(() => {
    tz = 'America/Caracas';
    now = DateTime.now().setZone(tz);
    const seed60 = buildSeed60();
    prisma = {
      clinic: {
        findUnique: jest.fn().mockResolvedValue({ timezone: tz }),
      },
      appointment: {
        // Se llama varias veces: seed60 primero, luego appts14, todayList,
        // pendingList y weekAppts. La implementación defaultea a arrays vacíos
        // salvo para el primer fetch (60d).
        findMany: jest
          .fn()
          // 1) fetch 60d (con relaciones)
          .mockResolvedValueOnce(seed60)
          // 2) appts14 (trend)
          .mockResolvedValueOnce([])
          // 3) apptsToday
          .mockResolvedValueOnce([])
          // 4) pendingList
          .mockResolvedValueOnce([])
          // 5) weekAppts (para occupancyRate)
          .mockResolvedValueOnce([]),
        count: jest.fn().mockResolvedValue(3), // confirmedCount
      },
      reminder: {
        count: jest.fn().mockResolvedValue(10), // sentCount
      },
      businessHour: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    controller = new DashboardController(prisma as unknown as PrismaService);
  });

  // ─── Legacy contract (mantener) ────────────────────────────────────────

  it('devuelve estructura completa con byStatus + noShowRate + confirmations + trend', async () => {
    const m = await controller.metrics(adminA);
    expect(m.byStatus.ATENDIDA).toBe(3);
    expect(m.byStatus.NO_SHOW).toBe(1);
    expect(m.byStatus.CONFIRMADA).toBe(1);
    expect(m.byStatus.CANCELADA).toBe(1);
    expect(m.noShowRate).toBeCloseTo(0.25, 4);
    expect(m.confirmations.sent).toBe(10);
    expect(m.confirmations.confirmed).toBe(3);
    expect(m.confirmations.rate).toBeCloseTo(0.3, 4);
    expect(m.trend).toHaveLength(14);
    expect(m.trend[0]).toHaveProperty('date');
    expect(m.trend[0]).toHaveProperty('created');
  });

  it('sin reminders enviados: rate=0 (guard contra división por cero)', async () => {
    prisma.reminder.count.mockResolvedValueOnce(0);
    const m = await controller.metrics(adminA);
    expect(m.confirmations.rate).toBe(0);
  });

  it('sin closed appts: noShowRate=0', async () => {
    // Reset del findMany: vaciamos TODOS los fetches (5 en total).
    prisma.appointment.findMany = jest
      .fn()
      .mockResolvedValueOnce([]) // 60d
      .mockResolvedValueOnce([]) // trend
      .mockResolvedValueOnce([]) // today
      .mockResolvedValueOnce([]) // pending
      .mockResolvedValueOnce([]); // week
    const m = await controller.metrics(adminA);
    expect(m.noShowRate).toBe(0);
  });

  it('SUPERADMIN sin impersonation activa → 400', async () => {
    await expect(controller.metrics(superadmin)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('impersonar'),
    });
  });

  it('SUPERADMIN sin impersonation + intent override → sigue siendo 400', async () => {
    await expect(controller.metrics(superadmin)).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.clinic.findUnique).not.toHaveBeenCalled();
  });

  it('SUPERADMIN impersonando (JWT con clinicId) → usa el clinicId del JWT para lookup', async () => {
    await controller.metrics(superadminImpersonatingZ);
    const call = prisma.clinic.findUnique.mock.calls[0][0];
    expect(call.where.id).toBe('clinic-Z');
  });

  // ─── Nuevos campos ─────────────────────────────────────────────────────

  describe('today', () => {
    it('agrega counts por status y devuelve upcoming (max 6, orden asc, dentro del día)', async () => {
      const in1h = now.plus({ hours: 1 });
      const in2h = now.plus({ hours: 2 });
      const in3h = now.plus({ hours: 3 });
      const yesterday = now.minus({ hours: 2 });
      const todayList = [
        {
          id: 't-past',
          startAt: yesterday.toJSDate(),
          endAt: yesterday.plus({ minutes: 30 }).toJSDate(),
          status: 'ATENDIDA',
          patient: { name: 'Juan', phone: '+58412' },
          service: { name: 'Consulta' },
          professional: { name: 'Ana', color: '#3b82f6' },
        },
        {
          id: 't1',
          startAt: in1h.toJSDate(),
          endAt: in1h.plus({ minutes: 30 }).toJSDate(),
          status: 'CONFIRMADA',
          patient: { name: 'Maria', phone: '+58414' },
          service: { name: 'Consulta' },
          professional: { name: 'Ana', color: '#3b82f6' },
        },
        {
          id: 't2',
          startAt: in2h.toJSDate(),
          endAt: in2h.plus({ minutes: 30 }).toJSDate(),
          status: 'PENDIENTE',
          patient: { name: null, phone: '+58416' },
          service: { name: 'Limpieza' },
          professional: { name: 'Beto', color: '#10b981' },
        },
        {
          id: 't3',
          startAt: in3h.toJSDate(),
          endAt: in3h.plus({ minutes: 30 }).toJSDate(),
          status: 'EN_RIESGO',
          patient: { name: 'Luis', phone: '+58418' },
          service: { name: 'Consulta' },
          professional: { name: 'Ana', color: '#3b82f6' },
        },
        {
          id: 't-cancel',
          startAt: in1h.toJSDate(),
          endAt: in1h.plus({ minutes: 30 }).toJSDate(),
          status: 'CANCELADA',
          patient: { name: 'x', phone: '+58419' },
          service: { name: 'x' },
          professional: { name: 'x', color: null },
        },
        {
          id: 't-noshow',
          startAt: in1h.toJSDate(),
          endAt: in1h.plus({ minutes: 30 }).toJSDate(),
          status: 'NO_SHOW',
          patient: { name: 'y', phone: '+58420' },
          service: { name: 'y' },
          professional: { name: 'y', color: null },
        },
      ];
      prisma.appointment.findMany = jest
        .fn()
        .mockResolvedValueOnce(buildSeed60())
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(todayList)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const m = await controller.metrics(adminA);
      expect(m.today.total).toBe(6);
      expect(m.today.confirmed).toBe(1);
      expect(m.today.pending).toBe(2); // PENDIENTE + EN_RIESGO
      expect(m.today.attended).toBe(1);
      expect(m.today.canceled).toBe(1);
      expect(m.today.noShow).toBe(1);
      // upcoming: 5 con startAt >= now (excluye el pasado) → ordenados
      expect(m.today.upcoming.length).toBeLessThanOrEqual(6);
      expect(m.today.upcoming.some((u) => u.id === 't-past')).toBe(false);
      expect(m.today.upcoming[0].id).toBe('t1');
      expect(m.today.upcoming[0].patientName).toBe('Maria');
      expect(m.today.upcoming[0].professionalColor).toBe('#3b82f6');
    });

    it('sin citas hoy → todos 0 y upcoming vacío', async () => {
      const m = await controller.metrics(adminA);
      expect(m.today.total).toBe(0);
      expect(m.today.upcoming).toEqual([]);
    });
  });

  describe('pendingConfirmation', () => {
    it('cuenta PENDIENTE en 72h y calcula hoursUntil redondeado', async () => {
      const in5h = now.plus({ hours: 5 });
      const in10h = now.plus({ hours: 10 });
      const pending = [
        {
          id: 'pd1',
          startAt: in5h.toJSDate(),
          patient: { name: 'A', phone: '+58412' },
          service: { name: 'X' },
          professional: { name: 'Ana' },
        },
        {
          id: 'pd2',
          startAt: in10h.toJSDate(),
          patient: { name: null, phone: '+58414' },
          service: { name: 'Y' },
          professional: { name: 'Beto' },
        },
      ];
      prisma.appointment.findMany = jest
        .fn()
        .mockResolvedValueOnce(buildSeed60())
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce([]);
      const m = await controller.metrics(adminA);
      expect(m.pendingConfirmation.total).toBe(2);
      expect(m.pendingConfirmation.next).toHaveLength(2);
      expect(m.pendingConfirmation.next[0].hoursUntil).toBe(5);
      expect(m.pendingConfirmation.next[1].hoursUntil).toBe(10);
      expect(m.pendingConfirmation.next[1].patientName).toBeNull();
    });

    it('limita next a 5 aunque haya más', async () => {
      const many = Array.from({ length: 8 }, (_, i) => ({
        id: `pd${i}`,
        startAt: now.plus({ hours: i + 1 }).toJSDate(),
        patient: { name: `P${i}`, phone: `+5841${i}` },
        service: { name: 'X' },
        professional: { name: 'A' },
      }));
      prisma.appointment.findMany = jest
        .fn()
        .mockResolvedValueOnce(buildSeed60())
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(many)
        .mockResolvedValueOnce([]);
      const m = await controller.metrics(adminA);
      expect(m.pendingConfirmation.total).toBe(8);
      expect(m.pendingConfirmation.next).toHaveLength(5);
    });
  });

  describe('deltas', () => {
    it('compara 30d actuales vs previos', async () => {
      const m = await controller.metrics(adminA);
      // seed: current=6 (a1..a6), previous=2 (a7, a8)
      expect(m.deltas.totalAppointments.current).toBe(6);
      expect(m.deltas.totalAppointments.previous).toBe(2);
      expect(m.deltas.totalAppointments.deltaPct).toBe(2); // (6-2)/2 = 2
      // revenue current: 3 ATENDIDA en s1 (5000×2) + s2 (3000) = 13000
      expect(m.deltas.revenueCents.current).toBe(13000);
      // revenue previous: 2 ATENDIDA × 5000 = 10000
      expect(m.deltas.revenueCents.previous).toBe(10000);
      expect(m.deltas.revenueCents.deltaPct).toBe(0.3); // (13000-10000)/10000
    });

    it('previous=0 && current=0 → deltaPct=0', async () => {
      prisma.appointment.findMany = jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const m = await controller.metrics(adminA);
      expect(m.deltas.totalAppointments.deltaPct).toBe(0);
      expect(m.deltas.revenueCents.deltaPct).toBe(0);
    });

    it('previous=0 && current>0 → deltaPct=1 (100%)', async () => {
      const yesterday = now.minus({ days: 1 });
      const seed = [
        {
          id: 'x1',
          status: 'ATENDIDA',
          startAt: yesterday.toJSDate(),
          endAt: yesterday.plus({ minutes: 30 }).toJSDate(),
          confirmedAt: null,
          patientId: 'p',
          serviceId: 's',
          service: { name: 'S', priceCents: 1000 },
          professionalId: 'pr',
          professional: { name: 'P', color: null },
        },
      ];
      prisma.appointment.findMany = jest
        .fn()
        .mockResolvedValueOnce(seed)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const m = await controller.metrics(adminA);
      expect(m.deltas.totalAppointments.deltaPct).toBe(1);
      expect(m.deltas.revenueCents.deltaPct).toBe(1);
    });
  });

  describe('topServices', () => {
    it('devuelve top 5 desc por count con revenue sumado', async () => {
      const m = await controller.metrics(adminA);
      // Del seed: s1 tiene 2 ATENDIDA (a1, a2), s2 tiene 1 (a3).
      expect(m.topServices).toHaveLength(2);
      expect(m.topServices[0].id).toBe('s1');
      expect(m.topServices[0].count).toBe(2);
      expect(m.topServices[0].revenueCents).toBe(10000);
      expect(m.topServices[1].id).toBe('s2');
      expect(m.topServices[1].count).toBe(1);
      expect(m.topServices[1].revenueCents).toBe(3000);
    });

    it('service con priceCents null → revenue 0', async () => {
      const yesterday = now.minus({ days: 1 });
      const seed = [
        {
          id: 'x',
          status: 'ATENDIDA',
          startAt: yesterday.toJSDate(),
          endAt: yesterday.plus({ minutes: 30 }).toJSDate(),
          confirmedAt: null,
          patientId: 'p',
          serviceId: 'free-s',
          service: { name: 'Free', priceCents: null },
          professionalId: 'pr',
          professional: { name: 'P', color: null },
        },
      ];
      prisma.appointment.findMany = jest
        .fn()
        .mockResolvedValueOnce(seed)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const m = await controller.metrics(adminA);
      expect(m.topServices[0].revenueCents).toBe(0);
    });
  });

  describe('topProfessionals', () => {
    it('cuenta attended y noShow por profesional, ordenado desc por attended', async () => {
      const m = await controller.metrics(adminA);
      // pr1: 2 ATENDIDA + 1 NO_SHOW. pr2: 1 ATENDIDA + 0 NO_SHOW.
      expect(m.topProfessionals[0].id).toBe('pr1');
      expect(m.topProfessionals[0].attended).toBe(2);
      expect(m.topProfessionals[0].noShow).toBe(1);
      expect(m.topProfessionals[0].color).toBe('#3b82f6');
      expect(m.topProfessionals[1].id).toBe('pr2');
      expect(m.topProfessionals[1].attended).toBe(1);
    });
  });

  describe('hourHeatmap', () => {
    it('devuelve exactamente 24 items (0..23) con counts en TZ clínica', async () => {
      const m = await controller.metrics(adminA);
      expect(m.hourHeatmap).toHaveLength(24);
      expect(m.hourHeatmap[0].hour).toBe(0);
      expect(m.hourHeatmap[23].hour).toBe(23);
      // La suma de todos los counts = total de appts en 30d (6 del seed).
      const sum = m.hourHeatmap.reduce((acc, x) => acc + x.count, 0);
      expect(sum).toBe(6);
    });
  });

  describe('occupancyRate', () => {
    it('sin BusinessHour → 0', async () => {
      const m = await controller.metrics(adminA);
      expect(m.occupancyRate).toBe(0);
    });

    it('con BusinessHour + citas → ratio calculado, capped a 1.0', async () => {
      // BH: 1 profesional, 8 horas/día × 5 días = 2400 minutos/semana.
      // Cita: 1 sola de 60 minutos → ratio = 60/2400 = 0.025.
      const yesterday = now.minus({ days: 1 });
      prisma.appointment.findMany = jest
        .fn()
        .mockResolvedValueOnce([]) // 60d
        .mockResolvedValueOnce([]) // trend
        .mockResolvedValueOnce([]) // today
        .mockResolvedValueOnce([]) // pending
        .mockResolvedValueOnce([
          {
            startAt: yesterday.toJSDate(),
            endAt: yesterday.plus({ minutes: 60 }).toJSDate(),
          },
        ]);
      prisma.businessHour.findMany.mockResolvedValueOnce(
        Array.from({ length: 5 }, () => ({
          startMinutes: 540, // 09:00
          endMinutes: 1020, // 17:00 → 480 min/día
        })),
      );
      const m = await controller.metrics(adminA);
      expect(m.occupancyRate).toBeCloseTo(0.025, 4);
    });

    it('citas exceden capacidad → cap a 1.0', async () => {
      const yesterday = now.minus({ days: 1 });
      prisma.appointment.findMany = jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            startAt: yesterday.toJSDate(),
            endAt: yesterday.plus({ hours: 20 }).toJSDate(),
          },
        ]);
      prisma.businessHour.findMany.mockResolvedValueOnce([
        { startMinutes: 540, endMinutes: 600 }, // solo 60 min de capacidad
      ]);
      const m = await controller.metrics(adminA);
      expect(m.occupancyRate).toBe(1);
    });
  });

  describe('activePatients30d', () => {
    it('cuenta pacientes únicos en 30d', async () => {
      const m = await controller.metrics(adminA);
      // seed current: p1, p2, p3, p1 (dup), p4, p5 → 5 únicos
      expect(m.activePatients30d).toBe(5);
    });
  });

  describe('sparklines', () => {
    it('devuelve exactamente 30 items (oldest first) para ambas series', async () => {
      const m = await controller.metrics(adminA);
      expect(m.sparklines.totalAppointments).toHaveLength(30);
      expect(m.sparklines.noShowRate).toHaveLength(30);
      // Suma de totalAppointments = 6 (los 6 del seed current).
      const sum = m.sparklines.totalAppointments.reduce((a, b) => a + b, 0);
      expect(sum).toBe(6);
      // noShowRate está en [0..1] siempre.
      for (const r of m.sparklines.noShowRate) {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
    });
  });

  // ─── Multi-tenant guards en queries nuevas ─────────────────────────────

  it('todas las queries nuevas incluyen scope (clinicId del user)', async () => {
    await controller.metrics(adminA);
    // fetch 60d (appts60)
    const call60 = prisma.appointment.findMany.mock.calls[0][0];
    expect(call60.where.clinicId).toBe('clinic-A');
    // pendingList
    const callPending = prisma.appointment.findMany.mock.calls[3][0];
    expect(callPending.where.clinicId).toBe('clinic-A');
    // weekAppts
    const callWeek = prisma.appointment.findMany.mock.calls[4][0];
    expect(callWeek.where.clinicId).toBe('clinic-A');
    // businessHour
    const callBH = prisma.businessHour.findMany.mock.calls[0][0];
    expect(callBH.where.clinicId).toBe('clinic-A');
  });
});
