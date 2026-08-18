import { setRequestLocale } from 'next-intl/server';
import type { AdminMetricsOverview } from '@/lib/admin';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { AdminDashboardClient } from './AdminDashboardClient';

export default async function AdminDashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const token = await getTokenFromCookies();
  const res = await fetcher<AdminMetricsOverview>(
    '/api/admin/metrics/overview',
    { token },
  );

  const initial: AdminMetricsOverview | null = res.ok ? res.data : null;

  return <AdminDashboardClient locale={locale} initial={initial} />;
}
