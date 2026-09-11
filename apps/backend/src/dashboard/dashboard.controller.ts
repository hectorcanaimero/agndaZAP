import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import {
  AppointmentSource,
  AppointmentStatus,
  ReminderStatus,
} from '@prisma/client';
import type Redis from 'ioredis';
import { DateTime } from 'luxon';
import { readBotStats } from '../bot/bot-stats';
import { REDIS_CLIENT } from '../public/rate-limit.guard';
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
  /**
   * Autogestión del paciente desde el link (S11): cuánto resuelve solo, sin
   * ocupar a recepción. Es la métrica que cuenta la historia del producto —
   * una cancelación con aviso es un hueco recuperable, no un no-show.
   */
  selfService: {
    canceled30d: number;
    rescheduled30d: number;
    /** Parte de las cancelaciones que pidió el paciente y no la clínica (0-1). */
    canceledShare: number;
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
  /**
   * Actividad del bot de WhatsApp en los últimos 30 días (M9).
   *
   * Sale de los contadores que escribe el propio bot en Redis, no de la base:
   * las intenciones y la tasa de NULL_ANSWER no viven en ninguna tabla. Ver
   * [[notas/2026-09-11-evento-bot-turn]].
   */
  botActivity: {
    windowDays: number;
    /**
     * `false` cuando no hay ni un contador en el periodo. El panel lo usa para
     * decir "todavía no hay datos" en vez de pintar ceros, que significan algo
     * distinto (que sí hubo actividad y fue nula).
     */
    hasData: boolean;
    /** Alguna lectura del periodo falló: los totales están incompletos. */
    partial: boolean;
    turns: {
      /** Incluye descartados y adjuntos: no es "turnos atendidos". */
      total: number;
      attended: number;
      unsupported: number;
      skipped: number;
      errors: number;
    };
    /**
     * Por qué no hay desglose, para que el panel no diga "hacen falta 10
     * mensajes" a una clínica que ya tiene 20.
     */
    breakdown: 'ok' | 'not-measured' | 'below-threshold';
    /**
     * `null` hasta que el bot cablee la anotación de intención, o cuando el
     * periodo no llega al mínimo de turnos. No es lo mismo que una lista vacía.
     */
    intents: Array<{ intent: string; count: number }> | null;
    /** Cuántos turnos acabaron derivando a una persona. `null` si no se mide. */
    handoffRate: number | null;
    /** De las consultas al RAG, cuántas acabaron en "no lo sé". `null` si no hay. */
    nullAnswerRate: number | null;
    citasPorOrigen: Array<{ source: string; count: number }>;
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
  canceledByPatient: boolean;
  rescheduleCount: number;
  source: AppointmentSource;
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
  /**
   * Mínimo de turnos para mostrar desgloses y tasas.
   *
   * En una clínica con dos mensajes en un mes, un desglose deja de ser una
   * métrica agregada y pasa a decir qué quería ese paciente concreto — y un
   * "100% derivados a una persona" sobre un turno dice que a ESA persona la
   * atendió un humano. Por debajo del umbral se muestran sólo los conteos.
   */
  private static readonly MIN_TURNS_FOR_BREAKDOWN = 10;

  /** Ventana del bloque de actividad del bot. */
  private static readonly BOT_WINDOW_DAYS = 30;

  /**
   * Tope para los contadores. El dashboard es lo que la clínica abre por la
   * mañana: preferimos el bloque sin datos antes que la página colgada.
   */
  private static readonly BOT_STATS_TIMEOUT_MS = 300;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

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
        canceledByPatient: true,
        rescheduleCount: true,
        // Por dónde entró la cita (BOT / PUBLIC / BOT_WEB): es la mitad de la
        // historia del bloque de actividad del bot.
        source: true,
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

    // ── Autogestión del paciente (S11) ────────────────────────────────────
    // Cuánto resuelve el paciente solo desde el link, sin ocupar a recepción.
    // Es la métrica que cuenta la historia del producto: una cancelación con
    // aviso es un hueco recuperable, lo contrario de un no-show. Se mide sobre
    // los MISMOS 30 días que el resto del bloque.
    let canceledByPatient30d = 0;
    let rescheduledByPatient30d = 0;
    for (const a of appts30) {
      if (a.canceledByPatient) canceledByPatient30d++;
      if (a.rescheduleCount > 0) rescheduledByPatient30d++;
    }
    // Proporción de las cancelaciones que pidió el paciente, no la clínica.
    const selfCancelShare =
      byStatus.CANCELADA === 0
        ? 0
        : Math.round((canceledByPatient30d / byStatus.CANCELADA) * 10000) /
          10000;

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

    // ── actividad del bot: 30 días (M9) ──────────────────────────────────
    // Los contadores vienen de Redis y las citas por origen de la base: son
    // dos fuentes porque miden cosas distintas. Un fallo de Redis degrada este
    // bloque a "sin datos", nunca tumba el resto del panel — el dashboard es
    // lo que la clínica abre por la mañana.
    const botWindow = DashboardController.BOT_WINDOW_DAYS;
    // Misma ventana que los contadores: `readBotStats` cuenta hoy más los 29
    // anteriores, así que las citas por origen se agrupan sobre ese mismo
    // rango. Si no, el bloque mezclaría dos periodos bajo un título.
    const botWindowStart = now
      .minus({ days: botWindow - 1 })
      .startOf('day')
      .toJSDate();

    const [botStats, sourceGroups] = await Promise.all([
      // Con Redis caído el catch alcanza, pero el modo de fallo que duele es
      // "vivo y lento": el cliente no tiene `commandTimeout`, así que sin la
      // carrera un Redis colgado se llevaría por delante todo el dashboard.
      Promise.race([
        readBotStats(this.redis, scope.clinicId, tz, botWindow, now),
        new Promise<null>((resolve) =>
          setTimeout(resolve, DashboardController.BOT_STATS_TIMEOUT_MS, null),
        ),
      ]).catch(() => null),
      // Por `createdAt`, NO por `startAt`. La pregunta que responde este bloque
      // es "¿cuántas citas me trajo el asistente?", y agrupar por `startAt`
      // contestaba "las que ya se celebraron" — dejando fuera justo las que el
      // bot agendó esta semana para la que viene.
      this.prisma.appointment.groupBy({
        by: ['source'],
        where: { ...scope, createdAt: { gte: botWindowStart } },
        _count: { _all: true },
      }),
    ]);

    const turnsTotal = botStats?.turns ?? 0;
    const ragTotal = botStats?.rag ?? null;
    // Umbral de privacidad: por debajo, un desglose deja de ser una métrica
    // agregada y pasa a decir qué quería un paciente concreto. Los conteos
    // brutos (turnos, adjuntos) sí se muestran: son volumen del propio canal
    // de la clínica, que ya ve mensaje a mensaje en su WhatsApp; lo que se
    // guarda es la CLASIFICACIÓN que hicimos nosotros.
    const enoughTurns = turnsTotal >= DashboardController.MIN_TURNS_FOR_BREAKDOWN;
    const intentsMeasured = Object.keys(botStats?.intents ?? {}).length > 0;

    const botActivity = {
      windowDays: botWindow,
      hasData: botStats?.hasData ?? false,
      partial: (botStats?.readErrors ?? 0) > 0,
      turns: {
        total: turnsTotal,
        attended: botStats?.outcomes.ok ?? 0,
        unsupported: botStats?.outcomes.unsupported ?? 0,
        skipped: botStats?.outcomes.skipped ?? 0,
        errors: botStats?.outcomes.error ?? 0,
      },
      /**
       * Por qué no hay desglose. El panel necesita distinguirlo: decirle
       * "hacen falta 10 mensajes" a una clínica que ya tiene 20 es una mentira
       * verificable por quien la lee.
       */
      breakdown: !intentsMeasured
        ? ('not-measured' as const)
        : !enoughTurns
          ? ('below-threshold' as const)
          : ('ok' as const),
      intents:
        intentsMeasured && enoughTurns
          ? Object.entries(botStats?.intents ?? {})
              .map(([intent, count]) => ({ intent, count }))
              .sort((a, b) => b.count - a.count)
          : null,
      // `null` cuando el contador no existe (nadie lo escribe todavía) o
      // cuando el volumen es tan bajo que la tasa hablaría de una persona.
      // Un 0 aquí diría "el bot no derivó nunca", que es una afirmación.
      handoffRate:
        botStats?.handoff !== null && botStats?.handoff !== undefined && enoughTurns
          ? botStats.handoff / turnsTotal
          : null,
      // Su denominador es el RAG, no los turnos: dividir entre turnos haría
      // que una clínica con mucho agendamiento y poca consulta pareciera tener
      // un RAG buenísimo.
      nullAnswerRate:
        ragTotal !== null &&
        ragTotal >= DashboardController.MIN_TURNS_FOR_BREAKDOWN
          ? (botStats?.nullAnswer ?? 0) / ragTotal
          : null,
      citasPorOrigen: sourceGroups
        .map((g) => ({ source: g.source as string, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
    };

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
      selfService: {
        canceled30d: canceledByPatient30d,
        rescheduled30d: rescheduledByPatient30d,
        /** Qué parte de las cancelaciones vino del paciente y no de la clínica. */
        canceledShare: selfCancelShare,
      },
      deltas,
      topServices,
      topProfessionals,
      hourHeatmap,
      occupancyRate,
      activePatients30d,
      sparklines,
      botActivity,
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
