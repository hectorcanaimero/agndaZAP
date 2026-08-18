import { Controller, Get, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminMetricsService, type OverviewMetrics } from './admin-metrics.service';

/**
 * AdminMetricsController — métricas globales cross-tenant para el panel SaaS.
 *
 * `GET /api/admin/metrics/overview` — snapshot del estado operativo de la plataforma.
 *
 * GET-only: no aplica `AdminAuditInterceptor` (leer métricas no se audita).
 * Rol requerido: SUPERADMIN.
 */
@Controller('admin/metrics')
@UseGuards(RolesGuard)
@Roles('SUPERADMIN')
export class AdminMetricsController {
  constructor(private readonly metricsService: AdminMetricsService) {}

  /**
   * `GET /api/admin/metrics/overview`
   *
   * Devuelve:
   * - `clinics`: breakdown por status (active/suspended/archived/total).
   * - `appointmentsLast30d`: total de citas en los últimos 30 días.
   * - `noShowRateLast30d`: fracción 0..1 sobre citas terminales del período.
   * - `topClinics`: top 5 clínicas por volumen de citas en los últimos 30 días.
   */
  @Get('overview')
  getOverview(): Promise<OverviewMetrics> {
    return this.metricsService.getOverview();
  }
}
