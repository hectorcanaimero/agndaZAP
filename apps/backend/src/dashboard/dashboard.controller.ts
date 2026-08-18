import { Controller, Get, NotFoundException, UseGuards } from '@nestjs/common';
import { AppointmentStatus, ReminderStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';

export interface DashboardMetrics {
  // === Legacy (mantener por compatibilidad con el frontend actual) ===
  noShowRate: number;
  byStatus: Record<AppointmentStatus, number>;
  confirmations: { sent: number; confirmed: number; rate: number };
  trend: Array<{
    date: string;
    created: number;
    confirmed: number;
    noShow: number;
  }>;

  // === Nuevos campos ===
  today: {
    total: number;
    confirmed: number;
    pending: number; // PENDIENTE + EN_RIESGO
    attended: number;
    canceled: number;
    noShow: number;
    upcoming: Array<{
      id: string;
      startAt: string;
      endAt: string;
      status: AppointmentStatus;
      patientName: string | null;
      patientPhone: string;
      serviceName: string;
      professionalName: string;
      professionalColor: string | null;
    }>;
  };
  pendingConfirmation: {
    total: number;
    next: Array<{
      id: string;
      startAt: string;
      hoursUntil: number;
      patientName: string | null;
      patientPhone: string;
      serviceName: string;
      professionalName: string;
    }>;
  };
  deltas: {
    totalAppointments: { current: number; previous: number; deltaPct: number };
    noShowRate: { current: number; previous: number; deltaPct: number };
    confirmationRate: { current: number; previous: number; deltaPct: number };
    revenueCents: { current: number; previous: number; deltaPct: number };
  };
  topServices: Array<{
    id: string;
    name: string;
    count: number;
    revenueCents: number;
  }>;
  topProfessionals: Array<{
    id: string;
    name: string;
    color: string | null;
    attended: number;
    noShow: number;
  }>;
  hourHeatmap: Array<{ hour: number; count: number }>;
  occupancyRate: number;
  activePatients30d: number;
  sparklines: {
    totalAppointments: number[];
    noShowRate: number[];
  };
}

// Tipo interno para las appts del rango 60d con `select` expandido.
// Reutilizamos este fetch para: byStatus/noShowRate (30d), deltas (60d),
// hourHeatmap (30d), topServices/topProfessionals (30d), sparklines (30d).
interface Appt60d {
  id: string;
  status: AppointmentStatus;
  startAt: Date;
  endAt: Date;
  confirmedAt: Date | null;
  patientId: string;
  serviceId: string;
  service: { name: string; priceCents: number | null };
  professionalId: string;
  professional: { name: string; color: string | null };
}

/**
 * DashboardController — métricas del panel.
 *
 * Todo en la TZ de la clínica (via Luxon). Ventanas:
 * - byStatus + noShowRate + confirmations + topServices + topProfessionals +
 *   hourHeatmap + activePatients30d + sparklines: últimos 30 días.
 * - deltas: 30d actuales vs 30d anteriores (fetch único de 60d).
 * - trend: últimos 14 días con daily buckets.
 * - today: rango del día en TZ de la clínica.
 * - pendingConfirmation: próximas 72 hs (PENDIENTE).
 * - occupancyRate: semana actual (lunes a domingo, TZ clínica).
 */
@Controller('dashboard')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('metrics')
  async metrics(@CurrentUser() user: AuthUser): Promise<DashboardMetrics> {
    // Multi-tenant estricto: TODAS las queries pasan por `scope` (spread).
    // NO usamos `clinicId:` suelto — cualquier query nueva DEBE derivarse de
    // este `scope` para no romper el patrón (ripgrep del CI).
    const scope = tenantWhere(user);
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: scope.clinicId },
      select: { timezone: true },
    });
    if (!clinic) throw new NotFoundException('clínica no encontrada');
    const tz = clinic.timezone;

    const now = DateTime.now().setZone(tz);
    const start30 = now.minus({ days: 30 }).startOf('day');
    const start60 = now.minus({ days: 60 }).startOf('day');
    const start14 = now.minus({ days: 13 }).startOf('day'); // hoy + 13 anteriores = 14 días
    const startOfToday = now.startOf('day');
    const endOfToday = now.endOf('day');
    const in72h = now.plus({ hours: 72 });

    // ── Fetch único 60d (con relaciones) ──────────────────────────────────
    // Reutilizado para byStatus, noShowRate, deltas, hourHeatmap, topServices,
    // topProfessionals, sparklines y activePatients30d. Evita N queries y
    // mantiene la consistencia (mismo snapshot para toda la request).
    const appts60: Appt60d[] = await this.prisma.appointment.findMany({
      where: {
        ...scope,
        startAt: { gte: start60.toJSDate(), lte: now.toJSDate() },
      },
      select: {
        id: true,
        status: true,
        startAt: true,
        endAt: true,
        confirmedAt: true,
        patientId: true,
        serviceId: true,
        service: { select: { name: true, priceCents: true } },
        professionalId: true,
        professional: { select: { name: true, color: true } },
      },
    });

    // Partición 60d → current (30d) + previous (30-60d atrás).
    const start30JS = start30.toJSDate();
    const appts30 = appts60.filter((a) => a.startAt >= start30JS);
    const apptsPrev30 = appts60.filter((a) => a.startAt < start30JS);

    // ── Legacy: byStatus + noShowRate (30d) ───────────────────────────────
    const byStatus: Record<AppointmentStatus, number> = {
      PENDIENTE: 0,
      CONFIRMADA: 0,
      EN_RIESGO: 0,
      ATENDIDA: 0,
      CANCELADA: 0,
      NO_SHOW: 0,
    };
    for (const a of appts30) byStatus[a.status]++;

    const closed = byStatus.ATENDIDA + byStatus.NO_SHOW;
    const noShowRate = closed === 0 ? 0 : byStatus.NO_SHOW / closed;

    // ── Confirmations (30d) ───────────────────────────────────────────────
    const [sentCount, confirmedCount] = await Promise.all([
      this.prisma.reminder.count({
        where: {
          appointment: { ...scope },
          status: {
            in: [ReminderStatus.SENT, ReminderStatus.CONFIRMED],
          },
          fireAt: { gte: start30.toJSDate(), lte: now.toJSDate() },
        },
      }),
      this.prisma.appointment.count({
        where: {
          ...scope,
          confirmedAt: { gte: start30.toJSDate(), lte: now.toJSDate() },
        },
      }),
    ]);
    const rate = sentCount === 0 ? 0 : confirmedCount / sentCount;

    // ── Trend 14d (legacy) ───────────────────────────────────────────────
    const appts14 = await this.prisma.appointment.findMany({
      where: {
        ...scope,
        OR: [
          { createdAt: { gte: start14.toJSDate() } },
          { confirmedAt: { gte: start14.toJSDate() } },
          { startAt: { gte: start14.toJSDate() } },
        ],
      },
      select: {
        status: true,
        createdAt: true,
        confirmedAt: true,
        startAt: true,
      },
    });

    const trendMap = new Map<
      string,
      { created: number; confirmed: number; noShow: number }
    >();
    for (let i = 0; i < 14; i++) {
      const d = start14.plus({ days: i }).toFormat('yyyy-MM-dd');
      trendMap.set(d, { created: 0, confirmed: 0, noShow: 0 });
    }
    for (const a of appts14) {
      const createdDay = DateTime.fromJSDate(a.createdAt)
        .setZone(tz)
        .toFormat('yyyy-MM-dd');
      const confirmedDay = a.confirmedAt
        ? DateTime.fromJSDate(a.confirmedAt).setZone(tz).toFormat('yyyy-MM-dd')
        : null;
      const startDay = DateTime.fromJSDate(a.startAt)
        .setZone(tz)
        .toFormat('yyyy-MM-dd');
      const created = trendMap.get(createdDay);
      if (created) created.created++;
      if (confirmedDay) {
        const c = trendMap.get(confirmedDay);
        if (c) c.confirmed++;
      }
      if (a.status === AppointmentStatus.NO_SHOW) {
        const n = trendMap.get(startDay);
        if (n) n.noShow++;
      }
    }
    const trend = Array.from(trendMap.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, v]) => ({ date, ...v }));

    // ── today: agregados + próximas 6 ─────────────────────────────────────
    // Query dedicada porque `appts60` sólo trae startAt <= now (necesitamos
    // las próximas del día). Incluimos patient/service/professional para
    // renderizar la lista sin joins adicionales.
    const apptsToday = await this.prisma.appointment.findMany({
      where: {
        ...scope,
        startAt: {
          gte: startOfToday.toJSDate(),
          lte: endOfToday.toJSDate(),
        },
      },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        status: true,
        patient: { select: { name: true, phone: true } },
        service: { select: { name: true } },
        professional: { select: { name: true, color: true } },
      },
      orderBy: { startAt: 'asc' },
    });

    let todayTotal = 0;
    let todayConfirmed = 0;
    let todayPending = 0;
    let todayAttended = 0;
    let todayCanceled = 0;
    let todayNoShow = 0;
    for (const a of apptsToday) {
      todayTotal++;
      switch (a.status) {
        case AppointmentStatus.CONFIRMADA:
          todayConfirmed++;
          break;
        case AppointmentStatus.PENDIENTE:
        case AppointmentStatus.EN_RIESGO:
          todayPending++;
          break;
        case AppointmentStatus.ATENDIDA:
          todayAttended++;
          break;
        case AppointmentStatus.CANCELADA:
          todayCanceled++;
          break;
        case AppointmentStatus.NO_SHOW:
          todayNoShow++;
          break;
      }
    }

    const nowJS = now.toJSDate();
    const endOfTodayJS = endOfToday.toJSDate();
    const upcoming = apptsToday
      .filter((a) => a.startAt >= nowJS && a.endAt < endOfTodayJS)
      .slice(0, 6)
      .map((a) => ({
        id: a.id,
        startAt: a.startAt.toISOString(),
        endAt: a.endAt.toISOString(),
        status: a.status,
        patientName: a.patient?.name ?? null,
        patientPhone: a.patient?.phone ?? '',
        serviceName: a.service?.name ?? '',
        professionalName: a.professional?.name ?? '',
        professionalColor: a.professional?.color ?? null,
      }));

    // ── pendingConfirmation: PENDIENTE en próximas 72 h ───────────────────
    const pendingList = await this.prisma.appointment.findMany({
      where: {
        ...scope,
        status: AppointmentStatus.PENDIENTE,
        startAt: { gte: nowJS, lte: in72h.toJSDate() },
      },
      select: {
        id: true,
        startAt: true,
        patient: { select: { name: true, phone: true } },
        service: { select: { name: true } },
        professional: { select: { name: true } },
      },
      orderBy: { startAt: 'asc' },
    });
    const pendingNext = pendingList.slice(0, 5).map((a) => {
      const hours = DateTime.fromJSDate(a.startAt)
        .setZone(tz)
        .diff(now, 'hours').hours;
      return {
        id: a.id,
        startAt: a.startAt.toISOString(),
        hoursUntil: Math.round(hours),
        patientName: a.patient?.name ?? null,
        patientPhone: a.patient?.phone ?? '',
        serviceName: a.service?.name ?? '',
        professionalName: a.professional?.name ?? '',
      };
    });

    // ── deltas: 30d actuales vs 30d anteriores ────────────────────────────
    const totalCurrent = appts30.length;
    const totalPrevious = apptsPrev30.length;

    let atendidaPrev = 0;
    let noShowPrev = 0;
    let confirmedAtPrev = 0;
    let revenuePrev = 0;
    for (const a of apptsPrev30) {
      if (a.status === AppointmentStatus.ATENDIDA) {
        atendidaPrev++;
        revenuePrev += a.service?.priceCents ?? 0;
      }
      if (a.status === AppointmentStatus.NO_SHOW) noShowPrev++;
      if (a.confirmedAt) confirmedAtPrev++;
    }
    const closedPrev = atendidaPrev + noShowPrev;
    const noShowRatePrev = closedPrev === 0 ? 0 : noShowPrev / closedPrev;
    // ConfirmationRate en la ventana previa se aproxima con el ratio de citas
    // con confirmedAt sobre el total (misma señal cualitativa que la legacy).
    const confirmRatePrev =
      totalPrevious === 0 ? 0 : confirmedAtPrev / totalPrevious;
    const confirmRateCurrent =
      totalCurrent === 0
        ? 0
        : appts30.filter((a) => a.confirmedAt !== null).length / totalCurrent;

    let revenueCurrent = 0;
    for (const a of appts30) {
      if (a.status === AppointmentStatus.ATENDIDA) {
        revenueCurrent += a.service?.priceCents ?? 0;
      }
    }

    const deltas = {
      totalAppointments: {
        current: totalCurrent,
        previous: totalPrevious,
        deltaPct: pct(totalCurrent, totalPrevious),
      },
      noShowRate: {
        current: noShowRate,
        previous: noShowRatePrev,
        deltaPct: pct(noShowRate, noShowRatePrev),
      },
      confirmationRate: {
        current: confirmRateCurrent,
        previous: confirmRatePrev,
        deltaPct: pct(confirmRateCurrent, confirmRatePrev),
      },
      revenueCents: {
        current: revenueCurrent,
        previous: revenuePrev,
        deltaPct: pct(revenueCurrent, revenuePrev),
      },
    };

    // ── topServices (30d, ATENDIDA) ───────────────────────────────────────
    const svcAgg = new Map<
      string,
      { name: string; count: number; revenueCents: number }
    >();
    for (const a of appts30) {
      if (a.status !== AppointmentStatus.ATENDIDA) continue;
      const entry = svcAgg.get(a.serviceId) ?? {
        name: a.service?.name ?? '',
        count: 0,
        revenueCents: 0,
      };
      entry.count++;
      entry.revenueCents += a.service?.priceCents ?? 0;
      svcAgg.set(a.serviceId, entry);
    }
    const topServices = Array.from(svcAgg.entries())
      .map(([id, v]) => ({ id, name: v.name, count: v.count, revenueCents: v.revenueCents }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // ── topProfessionals (30d) ────────────────────────────────────────────
    const profAgg = new Map<
      string,
      { name: string; color: string | null; attended: number; noShow: number }
    >();
    for (const a of appts30) {
      const entry = profAgg.get(a.professionalId) ?? {
        name: a.professional?.name ?? '',
        color: a.professional?.color ?? null,
        attended: 0,
        noShow: 0,
      };
      if (a.status === AppointmentStatus.ATENDIDA) entry.attended++;
      if (a.status === AppointmentStatus.NO_SHOW) entry.noShow++;
      profAgg.set(a.professionalId, entry);
    }
    const topProfessionals = Array.from(profAgg.entries())
      .map(([id, v]) => ({
        id,
        name: v.name,
        color: v.color,
        attended: v.attended,
        noShow: v.noShow,
      }))
      .sort((a, b) => b.attended - a.attended)
      .slice(0, 5);

    // ── hourHeatmap (30d, hora local de la clínica) ───────────────────────
    const heatMap = new Map<number, number>();
    for (let h = 0; h < 24; h++) heatMap.set(h, 0);
    for (const a of appts30) {
      const h = DateTime.fromJSDate(a.startAt).setZone(tz).hour;
      heatMap.set(h, (heatMap.get(h) ?? 0) + 1);
    }
    const hourHeatmap = Array.from(heatMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([hour, count]) => ({ hour, count }));

    // ── occupancyRate: semana actual (lunes-domingo, TZ clínica) ──────────
    // Numerador: suma de duraciones (minutos) de citas cuyo startAt cae en la
    // semana actual (ATENDIDA + CONFIRMADA + PENDIENTE + EN_RIESGO — no
    // canceladas ni no-show). Denominador: minutos disponibles según
    // BusinessHour de todos los profesionales de la clínica para esa semana.
    // Si no hay BusinessHour definido → 0 (evita falso 100%).
    const weekStart = now.startOf('week'); // Luxon: lunes por default (ISO)
    const weekEnd = now.endOf('week');
    const [weekAppts, businessHours] = await Promise.all([
      this.prisma.appointment.findMany({
        where: {
          ...scope,
          startAt: {
            gte: weekStart.toJSDate(),
            lte: weekEnd.toJSDate(),
          },
          status: {
            in: [
              AppointmentStatus.CONFIRMADA,
              AppointmentStatus.PENDIENTE,
              AppointmentStatus.EN_RIESGO,
              AppointmentStatus.ATENDIDA,
            ],
          },
        },
        select: { startAt: true, endAt: true },
      }),
      this.prisma.businessHour.findMany({
        where: { ...scope },
        select: { startMinutes: true, endMinutes: true },
      }),
    ]);

    let occupiedMinutes = 0;
    for (const a of weekAppts) {
      const dur =
        (a.endAt.getTime() - a.startAt.getTime()) / 60000; // ms → min
      if (dur > 0) occupiedMinutes += dur;
    }
    // BusinessHour representa un slot semanal recurrente (weekday + rango
    // horario). La suma de todos sus rangos = capacidad total de la semana.
    let capacityMinutes = 0;
    for (const bh of businessHours) {
      const slot = bh.endMinutes - bh.startMinutes;
      if (slot > 0) capacityMinutes += slot;
    }
    const occupancyRate =
      capacityMinutes === 0
        ? 0
        : Math.min(1, occupiedMinutes / capacityMinutes);

    // ── activePatients30d ────────────────────────────────────────────────
    const activePatientsSet = new Set<string>();
    for (const a of appts30) activePatientsSet.add(a.patientId);
    const activePatients30d = activePatientsSet.size;

    // ── sparklines: 30 días (oldest first) ────────────────────────────────
    // totalAppointments[day] = # citas del día por startAt en TZ clínica.
    // noShowRate[day] = NO_SHOW / (ATENDIDA + NO_SHOW), 0 si closed==0.
    const dayKeys: string[] = [];
    for (let i = 29; i >= 0; i--) {
      dayKeys.push(now.minus({ days: i }).toFormat('yyyy-MM-dd'));
    }
    const totalByDay = new Map<string, number>();
    const attendedByDay = new Map<string, number>();
    const noShowByDay = new Map<string, number>();
    for (const k of dayKeys) {
      totalByDay.set(k, 0);
      attendedByDay.set(k, 0);
      noShowByDay.set(k, 0);
    }
    for (const a of appts30) {
      const day = DateTime.fromJSDate(a.startAt)
        .setZone(tz)
        .toFormat('yyyy-MM-dd');
      if (!totalByDay.has(day)) continue;
      totalByDay.set(day, (totalByDay.get(day) ?? 0) + 1);
      if (a.status === AppointmentStatus.ATENDIDA) {
        attendedByDay.set(day, (attendedByDay.get(day) ?? 0) + 1);
      } else if (a.status === AppointmentStatus.NO_SHOW) {
        noShowByDay.set(day, (noShowByDay.get(day) ?? 0) + 1);
      }
    }
    const sparklines = {
      totalAppointments: dayKeys.map((k) => totalByDay.get(k) ?? 0),
      noShowRate: dayKeys.map((k) => {
        const at = attendedByDay.get(k) ?? 0;
        const ns = noShowByDay.get(k) ?? 0;
        const cl = at + ns;
        return cl === 0 ? 0 : ns / cl;
      }),
    };

    return {
      noShowRate,
      byStatus,
      confirmations: {
        sent: sentCount,
        confirmed: confirmedCount,
        rate,
      },
      trend,
      today: {
        total: todayTotal,
        confirmed: todayConfirmed,
        pending: todayPending,
        attended: todayAttended,
        canceled: todayCanceled,
        noShow: todayNoShow,
        upcoming,
      },
      pendingConfirmation: {
        total: pendingList.length,
        next: pendingNext,
      },
      deltas,
      topServices,
      topProfessionals,
      hourHeatmap,
      occupancyRate,
      activePatients30d,
      sparklines,
    };
  }
}

/**
 * Delta porcentual entre `current` y `previous`, redondeado a 4 decimales.
 * Edge cases:
 *  - previous === 0 && current === 0 → 0 (sin cambio)
 *  - previous === 0 && current !== 0 → 1 (100 % de "nueva" magnitud)
 */
function pct(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 1;
  return Math.round(((current - previous) / previous) * 10000) / 10000;
}
