import { setRequestLocale, getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { DashboardTrendChart } from './DashboardTrendChart';
import { LucideIcon } from './LucideIcon';

interface DashboardMetrics {
  noShowRate: number;
  byStatus: {
    PENDIENTE: number;
    CONFIRMADA: number;
    EN_RIESGO: number;
    ATENDIDA: number;
    CANCELADA: number;
    NO_SHOW: number;
  };
  confirmations: { sent: number; confirmed: number; rate: number };
  trend: Array<{
    date: string;
    created: number;
    confirmed: number;
    noShow: number;
  }>;
}

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

/**
 * Dashboard SSR — trae `GET /api/dashboard/metrics` en el server con el token
 * del cookie. Renderiza 4 cards + un shadcn Chart (Recharts) para la tendencia.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.dashboard');

  const token = await getTokenFromCookies();
  const res = await fetcher<DashboardMetrics>('/api/dashboard/metrics', {
    token,
  });

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
  const noShowPct = (metrics.noShowRate * 100).toFixed(1);
  const confirmationPct = (metrics.confirmations.rate * 100).toFixed(1);
  const total = Object.values(metrics.byStatus).reduce((a, b) => a + b, 0);

  // Sample sizes para dar contexto a las tasas (%). Sin denominador el operador
  // no puede distinguir "100% con 1 cita" de "100% con 100 citas".
  const noShowShows = metrics.byStatus.NO_SHOW;
  const noShowClosed = metrics.byStatus.ATENDIDA + metrics.byStatus.NO_SHOW;

  // Trend con label pre-formateado en el server — el client Chart ya lo recibe listo.
  const trendData = metrics.trend.map((d) => ({
    ...d,
    label: formatDayLabel(d.date, locale),
  }));

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          {t('title')}
        </h1>
        <p className="text-sm text-gray-500">{t('subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* No-show rate — TrendingDown como acento visual (métrica "menos = mejor") */}
        <Card className="transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('noShow.title')}
            </CardTitle>
            <LucideIcon
              name="TrendingDown"
              className="h-4 w-4 text-red-500"
              aria-hidden="true"
            />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums text-gray-900">
              {noShowPct}%
            </p>
            <p className="mt-1 text-xs text-gray-600 tabular-nums">
              {t('noShow.sample', {
                shows: noShowShows,
                closed: noShowClosed,
              })}
            </p>
            <p className="mt-1 text-xs text-gray-500">{t('noShow.hint')}</p>
          </CardContent>
        </Card>

        {/* Citas por estado — PieChart como acento */}
        <Card className="transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('byStatus.title')}
            </CardTitle>
            <LucideIcon
              name="PieChart"
              className="h-4 w-4 text-gray-400"
              aria-hidden="true"
            />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {(
                [
                  'PENDIENTE',
                  'CONFIRMADA',
                  'EN_RIESGO',
                  'ATENDIDA',
                  'CANCELADA',
                  'NO_SHOW',
                ] as const
              ).map((s) => (
                <div key={s} className="flex items-center justify-between">
                  <span className="text-gray-600">
                    {t(`status.${s}` as const)}
                  </span>
                  <span className="font-medium tabular-nums text-gray-900">
                    {metrics.byStatus[s]}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {t('byStatus.total', { total })}
            </p>
          </CardContent>
        </Card>

        {/* Tasa de confirmación — CheckCircle2 verde */}
        <Card className="transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('confirmations.title')}
            </CardTitle>
            <LucideIcon
              name="CheckCircle2"
              className="h-4 w-4 text-brand-600"
              aria-hidden="true"
            />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums text-gray-900">
              {confirmationPct}%
            </p>
            <p className="mt-1 text-xs text-gray-600 tabular-nums">
              {t('confirmations.sample', {
                confirmed: metrics.confirmations.confirmed,
                sent: metrics.confirmations.sent,
              })}
            </p>
            <div className="mt-2 space-y-0.5 text-sm text-gray-600">
              <p>
                {t('confirmations.sent')}:{' '}
                <span className="font-medium tabular-nums text-gray-900">
                  {metrics.confirmations.sent}
                </span>
              </p>
              <p>
                {t('confirmations.confirmed')}:{' '}
                <span className="font-medium tabular-nums text-gray-900">
                  {metrics.confirmations.confirmed}
                </span>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Tendencia — chart shadcn (Recharts). El card ocupa 1 columna pero el
            chart interno respira mejor. LineChart icon como acento. */}
        <Card className="transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('trend.title')}
            </CardTitle>
            <LucideIcon
              name="LineChart"
              className="h-4 w-4 text-gray-400"
              aria-hidden="true"
            />
          </CardHeader>
          <CardContent>
            <DashboardTrendChart
              trend={trendData}
              labels={{
                created: t('trend.legend.created'),
                noShow: t('trend.legend.noShow'),
                ariaLabel: t('trend.ariaLabel'),
              }}
            />

            {/* Alternativa keyboard-accessible al chart — <details> + <table>
                con las 14 filas × 3 columnas. Tab llega al summary, Enter/Space
                abre. WCAG 2.1.1. */}
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-gray-700 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">
                {t('trend.detailToggle')}
              </summary>
              <table className="mt-2 w-full text-sm">
                <caption className="sr-only">
                  {t('trend.tableCaption')}
                </caption>
                <thead>
                  <tr className="border-b text-left text-gray-600">
                    <th className="py-1 pr-4 font-medium">
                      {t('trend.tableHeaders.date')}
                    </th>
                    <th className="py-1 pr-4 font-medium">
                      {t('trend.tableHeaders.created')}
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
                      <td className="py-1 tabular-nums">{day.noShow}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>

            <p className="mt-2 text-xs text-gray-500">{t('trend.hint')}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
