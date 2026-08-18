import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';

export interface FeedbackSummary {
  count: number;
  average: number; // 0 si no hay respuestas
  // Breakdown por score (1-5). Siempre incluye todos los buckets aunque estén en 0
  // — el frontend renderiza barras sin tener que reconstruir el shape.
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  // Ranking por profesional (ordenado desc por avg, luego por count). Solo profs
  // con al menos 1 respuesta para no ensuciar el listado con avg=0 falso.
  byProfessional: Array<{
    professionalId: string;
    professionalName: string;
    count: number;
    average: number;
  }>;
}

export interface FeedbackListItem {
  id: string;
  score: number;
  comment: string | null;
  respondedAt: Date;
  appointmentId: string;
  patientName: string | null;
  professionalId: string;
  professionalName: string;
  serviceName: string;
  appointmentStartAt: Date;
}

// FeedbackController — endpoints para el reporte de satisfacción del panel.
//
// - GET /feedback — lista paginada (default 50), filtro opcional por profesional.
// - GET /feedback/summary — agregados: avg, count, distribución, breakdown por prof.
//
// Multi-tenant estricto vía `tenantWhere` (los feedbacks tienen clinicId propio,
// no delegan al appointment). CLINIC_ADMIN + SUPERADMIN — el PROFESSIONAL no
// puede ver el feedback de otros profesionales (fuera de scope este PR).
@Controller('feedback')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class FeedbackController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('professionalId') professionalId?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<FeedbackListItem[]> {
    const scope = tenantWhere(user);
    // Cap defensivo: si el frontend pide 10k, devolvemos 200. UI actual muestra
    // paginado local; no vale la pena drenar la DB por un scroll infinito.
    const limit = Math.min(200, Math.max(1, Number.parseInt(limitRaw ?? '50', 10) || 50));

    const rows = await this.prisma.feedback.findMany({
      where: {
        ...scope,
        ...(professionalId
          ? { appointment: { professionalId } }
          : {}),
      },
      orderBy: { respondedAt: 'desc' },
      take: limit,
      include: {
        appointment: {
          include: {
            patient: { select: { name: true } },
            professional: { select: { id: true, name: true } },
            service: { select: { name: true } },
          },
        },
      },
    });

    return rows.map((f) => ({
      id: f.id,
      score: f.score,
      comment: f.comment,
      respondedAt: f.respondedAt,
      appointmentId: f.appointmentId,
      patientName: f.appointment.patient.name,
      professionalId: f.appointment.professional.id,
      professionalName: f.appointment.professional.name,
      serviceName: f.appointment.service.name,
      appointmentStartAt: f.appointment.startAt,
    }));
  }

  @Get('summary')
  async summary(
    @CurrentUser() user: AuthUser,
  ): Promise<FeedbackSummary> {
    const scope = tenantWhere(user);

    // Cargamos todo en memoria: N pequeño (respuestas de satisfacción, no eventos
    // de tracking). Si algún tenant explota en cardinalidad se migra a groupBy
    // + agg del lado de Postgres. Por ahora simplicidad > premature optimization.
    const rows = await this.prisma.feedback.findMany({
      where: scope,
      include: {
        appointment: {
          include: {
            professional: { select: { id: true, name: true } },
          },
        },
      },
    });

    const count = rows.length;
    const distribution: Record<'1' | '2' | '3' | '4' | '5', number> = {
      '1': 0, '2': 0, '3': 0, '4': 0, '5': 0,
    };
    let sum = 0;
    // Acumulador por profesional. Guardamos name para no volver a JOINear.
    const perProf = new Map<
      string,
      { name: string; total: number; sum: number }
    >();
    for (const r of rows) {
      sum += r.score;
      const k = String(r.score) as '1' | '2' | '3' | '4' | '5';
      if (k in distribution) distribution[k]++;
      const p = r.appointment.professional;
      const cur = perProf.get(p.id) ?? { name: p.name, total: 0, sum: 0 };
      cur.total += 1;
      cur.sum += r.score;
      perProf.set(p.id, cur);
    }

    const byProfessional = [...perProf.entries()]
      .map(([id, v]) => ({
        professionalId: id,
        professionalName: v.name,
        count: v.total,
        average: v.total === 0 ? 0 : v.sum / v.total,
      }))
      .sort((a, b) => b.average - a.average || b.count - a.count);

    return {
      count,
      average: count === 0 ? 0 : sum / count,
      distribution,
      byProfessional,
    };
  }
}
