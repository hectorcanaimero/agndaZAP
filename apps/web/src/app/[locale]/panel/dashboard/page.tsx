import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { fetcher, getTokenFromCookies } from '@/lib/auth';

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
 * Dashboard SSR — trae `GET /api/dashboard/metrics` en el server con el token
 * del cookie. Renderiza 4 cards + un mini bar chart SVG puro para la tendencia.
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

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500">{t('subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('noShow.title')}</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-3xl font-semibold text-gray-900">{noShowPct}%</p>
            <p className="mt-1 text-xs text-gray-500">{t('noShow.hint')}</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('byStatus.title')}</CardTitle>
          </CardHeader>
          <CardBody>
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
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('confirmations.title')}</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-3xl font-semibold text-gray-900">
              {confirmationPct}%
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
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('trend.title')}</CardTitle>
          </CardHeader>
          <CardBody>
            <TrendChart trend={metrics.trend} />
            <p className="mt-2 text-xs text-gray-500">{t('trend.hint')}</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/**
 * Mini bar chart SVG hand-rolled. Sin dependencia de recharts/chartjs — es un
 * MVP y todo lo que necesitamos es el shape de la tendencia.
 *
 * Renderiza dos series:
 * - `created` en `brand-500` (verde AgendaZap).
 * - `noShow`  en `red-500` (para atraer la vista).
 */
function TrendChart({
  trend,
}: {
  trend: Array<{
    date: string;
    created: number;
    confirmed: number;
    noShow: number;
  }>;
}) {
  const w = 280;
  const h = 80;
  const pad = 4;
  const bars = trend.length || 1;
  const barW = (w - pad * 2) / bars;
  const maxV = Math.max(
    1,
    ...trend.map((t) => Math.max(t.created, t.noShow)),
  );

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Tendencia 14 días"
      className="block h-20 w-full"
    >
      {trend.map((day, i) => {
        const x = pad + i * barW;
        const createdH = (day.created / maxV) * (h - 8);
        const noShowH = (day.noShow / maxV) * (h - 8);
        return (
          <g key={day.date}>
            <rect
              x={x + 1}
              y={h - createdH}
              width={Math.max(1, barW / 2 - 2)}
              height={createdH}
              fill="#16a34a"
            >
              <title>{`${day.date}: ${day.created} creadas`}</title>
            </rect>
            <rect
              x={x + barW / 2 + 1}
              y={h - noShowH}
              width={Math.max(1, barW / 2 - 2)}
              height={noShowH}
              fill="#ef4444"
            >
              <title>{`${day.date}: ${day.noShow} no-show`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
