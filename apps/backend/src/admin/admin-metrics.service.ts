import { Injectable } from '@nestjs/common';
import { AppointmentStatus, ClinicStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';

export interface OverviewMetrics {
  clinics: {
    active: number;
    suspended: number;
    archived: number;
    total: number;
  };
  appointmentsLast30d: number;
  /** Fracción 0..1. 0 si no hay citas terminales en el período. */
  noShowRateLast30d: number;
  /** Top 5 clínicas por volumen de citas en los últimos 30 días. */
  topClinics: Array<{
    id: string;
    name: string;
    slug: string;
    appointmentCount: number;
  }>;
}

/**
 * AdminMetricsService — métricas globales cross-tenant para el panel SaaS.
 *
 * No lleva clinicId en ninguna query — opera sobre TODA la base de datos.
 * Sólo accesible para SUPERADMIN (lo garantiza el controller + RolesGuard).
 *
 * Fechas con Luxon usando TZ global "America/Caracas" (sin clínica específica
 * el sistema necesita una referencia; se usa la TZ del servidor operativo).
 */
@Injectable()
export class AdminMetricsService {
  /** TZ de referencia para las ventanas temporales globales. */
  private static readonly GLOBAL_TZ = 'America/Caracas';

  constructor(private readonly prisma: PrismaService) {}

  async getOverview(): Promise<OverviewMetrics> {
    const now = DateTime.now().setZone(AdminMetricsService.GLOBAL_TZ);
    const start30 = now.minus({ days: 30 }).startOf('day').toJSDate();
    const nowJs = now.toJSDate();

    // ── 1. Clínicas por status ─────────────────────────────────────────────
    const clinicGroups = await this.prisma.clinic.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const clinicsByStatus: Record<string, number> = {};
    for (const g of clinicGroups) {
      clinicsByStatus[g.status] = g._count._all;
    }
    const active = clinicsByStatus[ClinicStatus.ACTIVE] ?? 0;
    const suspended = clinicsByStatus[ClinicStatus.SUSPENDED] ?? 0;
    const archived = clinicsByStatus[ClinicStatus.ARCHIVED] ?? 0;

    // ── 2. Citas últimos 30 días — count total + por status terminal ───────
    // Un solo findMany es más barato que dos queries separadas para tablas chicas,
    // pero para cross-tenant preferimos groupBy para no traer filas completas.
    const apptGroups = await this.prisma.appointment.groupBy({
      by: ['status'],
      where: { startAt: { gte: start30, lte: nowJs } },
      _count: { _all: true },
    });

    const apptByStatus: Record<string, number> = {};
    let appointmentsLast30d = 0;
    for (const g of apptGroups) {
      apptByStatus[g.status] = g._count._all;
      appointmentsLast30d += g._count._all;
    }

    // ── 3. noShowRate: terminales = ATENDIDA + NO_SHOW + CANCELADA ─────────
    const noShows = apptByStatus[AppointmentStatus.NO_SHOW] ?? 0;
    const terminal =
      (apptByStatus[AppointmentStatus.ATENDIDA] ?? 0) +
      noShows +
      (apptByStatus[AppointmentStatus.CANCELADA] ?? 0);
    const noShowRateLast30d = terminal === 0 ? 0 : noShows / terminal;

    // ── 4. Top 5 clínicas por volumen ─────────────────────────────────────
    const topGroups = await this.prisma.appointment.groupBy({
      by: ['clinicId'],
      where: { startAt: { gte: start30, lte: nowJs } },
      _count: { _all: true },
      orderBy: { _count: { clinicId: 'desc' } },
      take: 5,
    });

    // Traemos name/slug de las clínicas del top 5.
    const topClinicIds = topGroups.map((g) => g.clinicId);
    const topClinicRecords = await this.prisma.clinic.findMany({
      where: { id: { in: topClinicIds } },
      select: { id: true, name: true, slug: true },
    });
    const clinicById = new Map(topClinicRecords.map((c) => [c.id, c]));

    const topClinics = topGroups
      .map((g) => {
        const clinic = clinicById.get(g.clinicId);
        if (!clinic) return null;
        return {
          id: clinic.id,
          name: clinic.name,
          slug: clinic.slug,
          appointmentCount: g._count._all,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    return {
      clinics: { active, suspended, archived, total: active + suspended + archived },
      appointmentsLast30d,
      noShowRateLast30d,
      topClinics,
    };
  }
}
