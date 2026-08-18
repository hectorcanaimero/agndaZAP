import { Controller, Get, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { AppointmentStatus, ReminderStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';

export interface DashboardMetrics {
  noShowRate: number;
  byStatus: Record<AppointmentStatus, number>;
  confirmations: { sent: number; confirmed: number; rate: number };
  trend: Array<{
    date: string;
    created: number;
    confirmed: number;
    noShow: number;
  }>;
}

/**
 * DashboardController — métricas del panel.
 *
 * Todo en la TZ de la clínica (via Luxon). Ventanas:
 * - noShowRate + byStatus + confirmations: últimos 30 días.
 * - trend: últimos 14 días con daily buckets.
 */
@Controller('dashboard')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('metrics')
  async metrics(
    @CurrentUser() user: AuthUser,
  ): Promise<DashboardMetrics> {
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
    const start14 = now.minus({ days: 13 }).startOf('day'); // hoy + 13 anteriores = 14 días

    // 30d window: byStatus + noShowRate.
    const appts30 = await this.prisma.appointment.findMany({
      where: {
        ...scope,
        startAt: { gte: start30.toJSDate(), lte: now.toJSDate() },
      },
      select: { status: true, startAt: true, confirmedAt: true },
    });

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

    // Confirmations: recordatorios SENT + citas CONFIRMADA post-recordatorio.
    // Aproximación pragmática: contamos reminders SENT en 30d y appointments
    // CONFIRMADA con `confirmedAt` en 30d. El rate es una señal cualitativa
    // (no una regresión exacta 1:1), pero suficiente para el dashboard.
    const [sentCount, confirmedCount] = await Promise.all([
      this.prisma.reminder.count({
        where: {
          // Nesting: el scope aplica sobre `appointment` para reminders.
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

    // Trend 14d: agrupamos en JS (evitamos SQL crudo) porque el rango es chico.
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

    return {
      noShowRate,
      byStatus,
      confirmations: {
        sent: sentCount,
        confirmed: confirmedCount,
        rate,
      },
      trend,
    };
  }
}
