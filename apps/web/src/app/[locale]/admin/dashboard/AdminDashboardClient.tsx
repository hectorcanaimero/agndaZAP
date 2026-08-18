'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Archive,
  BarChart3,
  Building2,
  PauseCircle,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AdminMetricsOverview } from '@/lib/admin';
import { apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

interface Props {
  locale: string;
  initial: AdminMetricsOverview | null;
}

function formatPercent(v: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(v);
}

/**
 * AdminDashboardClient — snapshot cross-tenant para el SUPERADMIN.
 *
 * Sin gráficos por ahora — cards + top 5. Un chart temporal (citas por día)
 * puede venir cuando el backend exponga la serie.
 */
export function AdminDashboardClient({ locale, initial }: Props) {
  const t = useTranslations('admin.overview');
  const tImp = useTranslations('impersonation');
  const toastedRef = useRef(false);

  // Cuando el fetcher restaura la sesión tras un 401 durante impersonation,
  // redirige con `?imp=expired` — lo detectamos acá para mostrar un toast
  // informativo al operador.
  //
  // Se lee `window.location.search` directo en vez de `useSearchParams()` de
  // next/navigation: ese hook necesita `<Suspense>` boundary o hace SSR
  // bailout, y sin el boundary Next 15 en dev puede disparar re-renders/
  // re-navigations. Como este effect corre solo client-side (ya somos 'use
  // client') y solo una vez al montar, esto es más simple y sin trampas.
  useEffect(() => {
    if (toastedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('imp') !== 'expired') return;
    toastedRef.current = true;
    toast.info(tImp('toasts.restored'));
    // Limpiamos el query param para que un refresh manual no vuelva a
    // disparar el toast — sin trigger de navegación de React.
    params.delete('imp');
    const next = params.toString();
    const path = window.location.pathname + (next ? `?${next}` : '');
    window.history.replaceState(null, '', path);
  }, [tImp]);

  const { data, isError, refetch } = useQuery({
    queryKey: queryKeys.admin.metricsOverview,
    queryFn: () =>
      apiQuery<AdminMetricsOverview>('/api/admin/metrics/overview'),
    initialData: initial ?? undefined,
    staleTime: 30_000,
  });

  if (isError && !data) {
    return (
      <div className="flex flex-col gap-6">
        <Header />
        <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-md border border-border bg-card p-6 text-center">
          <p className="text-sm text-destructive">{t('loadError')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => refetch()}
          >
            {t('retry')}
          </Button>
        </div>
      </div>
    );
  }

  const overview = data;
  const noShow = overview?.noShowRateLast30d ?? 0;
  const noShowHigh = noShow >= 0.15;

  return (
    <div className="flex flex-col gap-6">
      <Header />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <MetricCard
          icon={Building2}
          label={t('cards.totalClinics')}
          value={overview?.clinics.total ?? '—'}
        />
        <MetricCard
          icon={Activity}
          label={t('cards.activeClinics')}
          value={overview?.clinics.active ?? '—'}
        />
        <MetricCard
          icon={PauseCircle}
          label={t('cards.suspendedClinics')}
          value={overview?.clinics.suspended ?? '—'}
          tone={
            (overview?.clinics.suspended ?? 0) > 0 ? 'destructive' : 'neutral'
          }
        />
        <MetricCard
          icon={Archive}
          label={t('cards.archivedClinics')}
          value={overview?.clinics.archived ?? '—'}
        />
        <MetricCard
          icon={BarChart3}
          label={t('cards.appointmentsLast30d')}
          value={overview?.appointmentsLast30d ?? '—'}
        />
        <MetricCard
          icon={AlertTriangle}
          label={t('cards.noShowRate')}
          value={overview ? formatPercent(noShow, locale) : '—'}
          tone={noShowHigh ? 'warning' : 'neutral'}
        />
      </section>

      {/* Top clinics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('topClinics.title')}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t('topClinics.subtitle')}
          </p>
        </CardHeader>
        <CardContent>
          {!overview || overview.topClinics.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('topClinics.empty')}
            </p>
          ) : (
            <ol className="flex flex-col divide-y divide-border">
              {overview.topClinics.map((c, idx) => (
                <li
                  key={c.id}
                  className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-semibold text-amber-900">
                    {idx + 1}
                  </span>
                  <Link
                    href={`/${locale}/admin/clinics/${c.id}`}
                    className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
                  >
                    {c.name}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {c.slug}
                    </span>
                  </Link>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
                    {t('topClinics.count', { n: c.appointmentCount })}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─────────────────────────── Sub-components ─────────────────────────── */

function Header() {
  const t = useTranslations('admin.overview');
  return (
    <div className="flex flex-col gap-1">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <BarChart3
          className="h-5 w-5 text-amber-600"
          aria-hidden="true"
          strokeWidth={2.25}
        />
        {t('title')}
      </h1>
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  tone?: 'neutral' | 'warning' | 'destructive';
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          <Icon
            className={cn(
              'h-3.5 w-3.5',
              tone === 'warning' && 'text-amber-600',
              tone === 'destructive' && 'text-destructive',
              tone === 'neutral' && 'text-muted-foreground',
            )}
            aria-hidden="true"
          />
        </div>
        <span
          className={cn(
            'text-2xl font-semibold tabular-nums text-foreground',
            tone === 'warning' && 'text-amber-700',
            tone === 'destructive' && 'text-destructive',
          )}
        >
          {value}
        </span>
      </CardContent>
    </Card>
  );
}
