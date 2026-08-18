import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies, type AuthMe } from '@/lib/auth';
import { DashboardTrendChart } from './DashboardTrendChart';
import { HourHeatmap } from './HourHeatmap';
import { KpiCard } from './KpiCard';
import { LucideIcon } from './LucideIcon';
import { PendingConfirmationPanel } from './PendingConfirmationPanel';
import { SectionCard } from './SectionCard';
import { StatusDonut } from './StatusDonut';
import { TodayPanel } from './TodayPanel';
import { TopProfessionalsList } from './TopProfessionalsList';
import { TopServicesBar } from './TopServicesBar';
import type { DashboardMetrics, AppointmentStatus } from './types';

/**
 * Dashboard SSR — "Clinical Operations Console".
 *
 * Fetch en el server con el token del cookie. Un solo request al backend
 * (`GET /api/dashboard/metrics`) trae TODO el shape del dashboard —
 * ver `./types.ts`.
 *
 * Layout (12-col mobile-up):
 *   Row 1 — 4 KPIs hero con sparkline + delta vs. 30d anteriores.
 *   Row 2 — Trend chart (col-8) + TodayPanel (col-4).
 *   Row 3 — PendingConfirmation (col-4) + Heatmap (col-4) + StatusDonut (col-4).
 *   Row 4 — TopServices (col-6) + TopProfessionals (col-6).
 *
 * Cada card entra escalonada con `animate-fade-up` y `animation-delay` inline —
 * CSS puro, sin JS extra. Total ~500ms hasta que todo está en pantalla.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.dashboard');
  const tStatus = await getTranslations('panel.dashboard.status');

  const token = await getTokenFromCookies();
  const [res, meRes] = await Promise.all([
    fetcher<DashboardMetrics>('/api/dashboard/metrics', { token }),
    fetcher<AuthMe>('/api/auth/me', { token }),
  ]);

  if (!res.ok) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <div className="mt-4 rounded-md bg-red-50 p-4 text-sm text-red-800">
          {t('errorLoading')} ({res.status})
        </div>
      </div>
    );
  }

  const metrics = res.data;
  const clinic = meRes.ok ? meRes.data.clinic : null;
  const tz = clinic?.timezone ?? 'America/Caracas';
  // Moneda por clínica (ISO 4217). El backend garantiza el default "USD" pero
  // dejamos el fallback local para tolerar responses cacheados de antes de la
  // migración `add_clinic_currency` sin romper la UI.
  const currencyCode = clinic?.currency ?? 'USD';

  const statusText: Record<AppointmentStatus, string> = {
    PENDIENTE: tStatus('PENDIENTE'),
    CONFIRMADA: tStatus('CONFIRMADA'),
    EN_RIESGO: tStatus('EN_RIESGO'),
    ATENDIDA: tStatus('ATENDIDA'),
    CANCELADA: tStatus('CANCELADA'),
    NO_SHOW: tStatus('NO_SHOW'),
  };

  // Trend con label pre-formateado en server (el client Chart lo recibe listo).
  const trendData = metrics.trend.map((d) => ({
    ...d,
    label: formatDayLabel(d.date, locale),
  }));

  // Formatters compartidos.
  const numberFmt = new Intl.NumberFormat(locale);
  const currencyFmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: 0,
  });
  const percentFmt = (n: number) => `${(n * 100).toFixed(1)}%`;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Header con eyebrow + title + timezone chip (contexto operativo). */}
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-teal-600">
            {t('eyebrow')}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-gray-900">
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-gray-500">{t('subtitle')}</p>
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-gray-200/80 bg-white px-3 py-1 text-[11px] font-medium text-gray-600 shadow-card-flat">
          <LucideIcon
            name="Clock3"
            className="h-3 w-3 text-gray-400"
            aria-hidden="true"
          />
          <span className="tabular-nums">{tz}</span>
        </div>
      </header>

      {/* Row 1 — KPIs hero */}
      <section
        aria-label={t('sections.kpiSection')}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <KpiCard
          eyebrow={t('kpi.totalAppointments.label')}
          value={numberFmt.format(metrics.deltas.totalAppointments.current)}
          hint={t('kpi.totalAppointments.hint')}
          icon="CalendarClock"
          tone="navy"
          deltaPct={metrics.deltas.totalAppointments.deltaPct}
          deltaLabel={t('deltas.vsPrevious30d')}
          spark={metrics.sparklines.totalAppointments}
          animationDelay={0}
        />
        <KpiCard
          eyebrow={t('kpi.noShow.label')}
          value={percentFmt(metrics.deltas.noShowRate.current)}
          hint={t('kpi.noShow.hint')}
          icon="TrendingDown"
          tone="rose"
          deltaPct={metrics.deltas.noShowRate.deltaPct}
          deltaLabel={t('deltas.vsPrevious30d')}
          invertDelta
          spark={metrics.sparklines.noShowRate}
          animationDelay={80}
        />
        <KpiCard
          eyebrow={t('kpi.confirmation.label')}
          value={percentFmt(metrics.deltas.confirmationRate.current)}
          hint={t('kpi.confirmation.hint')}
          icon="CheckCircle2"
          tone="teal"
          deltaPct={metrics.deltas.confirmationRate.deltaPct}
          deltaLabel={t('deltas.vsPrevious30d')}
          spark={metrics.sparklines.totalAppointments}
          animationDelay={160}
        />
        <KpiCard
          eyebrow={t('kpi.revenue.label')}
          value={currencyFmt.format(metrics.deltas.revenueCents.current / 100)}
          hint={t('kpi.revenue.hint')}
          icon="Wallet"
          tone="amber"
          deltaPct={metrics.deltas.revenueCents.deltaPct}
          deltaLabel={t('deltas.vsPrevious30d')}
          spark={metrics.sparklines.totalAppointments}
          animationDelay={240}
        />
      </section>

      {/* Row 2 — Trend chart (grande) + Today panel (columna operativa). */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard
          title={t('trend.title')}
          description={t('trend.subtitle')}
          icon="LineChart"
          className="lg:col-span-2"
          animationDelay={320}
          action={
            <span className="text-[11px] font-medium text-gray-500">
              {t('trend.rangeLabel')}
            </span>
          }
        >
          <DashboardTrendChart
            trend={trendData}
            labels={{
              created: t('trend.legend.created'),
              confirmed: t('trend.legend.confirmed'),
              noShow: t('trend.legend.noShow'),
              ariaLabel: t('trend.ariaLabel'),
            }}
          />

          {/* Detalle accesible con tabla (WCAG 2.1.1). */}
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-gray-500 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-navy">
              {t('trend.detailToggle')}
            </summary>
            <table className="mt-2 w-full text-sm">
              <caption className="sr-only">{t('trend.tableCaption')}</caption>
              <thead>
                <tr className="border-b text-left text-gray-600">
                  <th className="py-1 pr-4 font-medium">
                    {t('trend.tableHeaders.date')}
                  </th>
                  <th className="py-1 pr-4 font-medium">
                    {t('trend.tableHeaders.created')}
                  </th>
                  <th className="py-1 pr-4 font-medium">
                    {t('trend.tableHeaders.confirmed')}
                  </th>
                  <th className="py-1 font-medium">
                    {t('trend.tableHeaders.noShow')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {trendData.map((day) => (
                  <tr key={day.date} className="border-b border-gray-100">
                    <td className="py-1 pr-4 tabular-nums">{day.label}</td>
                    <td className="py-1 pr-4 tabular-nums">{day.created}</td>
                    <td className="py-1 pr-4 tabular-nums">{day.confirmed}</td>
                    <td className="py-1 tabular-nums">{day.noShow}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </SectionCard>

        <TodayPanel
          today={metrics.today}
          timezone={tz}
          locale={locale}
          agendaHref={`/${locale}/panel/agenda`}
          animationDelay={400}
          labels={{
            eyebrow: t('today.eyebrow'),
            description: t('today.description'),
            empty: t('today.empty'),
            emptyHint: t('today.emptyHint'),
            viewAgendaCta: t('today.viewAgendaCta'),
            progressLabel: t('today.progress'),
            remainingLabel: t('today.remaining'),
            statusFilled: t('today.statusFilled'),
            statusPending: t('today.statusPending'),
            with: t('today.with'),
            statusText,
          }}
        />
      </section>

      {/* Row 3 — Pending confirmation + Heatmap + Status donut. */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PendingConfirmationPanel
          data={metrics.pendingConfirmation}
          locale={locale}
          timezone={tz}
          animationDelay={480}
          href={`/${locale}/panel/agenda`}
          labels={{
            eyebrow: t('pending.eyebrow'),
            description: t('pending.description'),
            empty: t('pending.empty'),
            // t.raw: templates crudos con `{h}` / `{time}` — el cliente los
            // interpola por fila con .replace(). ICU los rechazaría acá.
            inHours: t.raw('pending.inHours'),
            inHoursTomorrow: t.raw('pending.inHoursTomorrow'),
            countAction: t('pending.countAction'),
            with: t('today.with'),
            now: t('pending.now'),
          }}
        />

        <SectionCard
          title={t('heatmap.eyebrow')}
          description={t('heatmap.description')}
          icon="Clock3"
          animationDelay={560}
        >
          <HourHeatmap
            data={metrics.hourHeatmap}
            labels={{
              // t.raw: templates crudos con `{count}`/`{hour}` — el cliente
              // los interpola por celda con .replace(). ICU los rechazaría acá.
              tooltip: t.raw('heatmap.tooltip'),
              tooltipOne: t.raw('heatmap.tooltipOne'),
              tooltipZero: t.raw('heatmap.tooltipZero'),
              peakLabel: t('heatmap.peak'),
              quietLabel: t('heatmap.quiet'),
            }}
          />
        </SectionCard>

        <SectionCard
          title={t('statusDist.eyebrow')}
          description={t('statusDist.description')}
          icon="PieChart"
          animationDelay={640}
        >
          <StatusDonut
            byStatus={metrics.byStatus}
            labels={{
              total: t('statusDist.total'),
              status: statusText,
            }}
          />
        </SectionCard>
      </section>

      {/* Row 4 — Signals de operación: top servicios + top profesionales. */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard
          title={t('topServices.eyebrow')}
          description={t('topServices.description')}
          icon="Sparkles"
          animationDelay={720}
          action={
            <MetricPill
              label={t('topServices.activePatients')}
              value={numberFmt.format(metrics.activePatients30d)}
            />
          }
        >
          <TopServicesBar
            data={metrics.topServices}
            locale={locale}
            labels={{
              empty: t('topServices.empty'),
              countLabel: t('topServices.countLabel'),
              currencyCode,
            }}
          />
        </SectionCard>

        <SectionCard
          title={t('topProfessionals.eyebrow')}
          description={t('topProfessionals.description')}
          icon="Users"
          animationDelay={800}
          action={
            <MetricPill
              label={t('topProfessionals.occupancy')}
              value={percentFmt(metrics.occupancyRate)}
            />
          }
        >
          <TopProfessionalsList
            data={metrics.topProfessionals}
            labels={{
              empty: t('topProfessionals.empty'),
              attendedShort: t('topProfessionals.attendedShort'),
              noShowShort: t('topProfessionals.noShowShort'),
              noShowRateLabel: t('topProfessionals.noShowRateLabel'),
            }}
          />
        </SectionCard>
      </section>

      {/* Footnote con contexto de la ventana. */}
      <p className="pb-8 text-center text-[11px] text-gray-400">{t('footer.window')}</p>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Formatea una fecha ISO (YYYY-MM-DD) al locale del usuario, en formato corto
 * "dd MMM" (ej. "05 ago" en es, "05 ago." en pt). Usa UTC para evitar shift
 * de día por TZ del server.
 */
function formatDayLabel(isoDate: string, locale: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(d);
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-50 px-2.5 py-1 text-[11px] font-medium text-gray-600 ring-1 ring-inset ring-gray-200/80">
      <span className="text-gray-500">{label}</span>
      <span className="font-semibold tabular-nums text-gray-900">{value}</span>
    </span>
  );
}
