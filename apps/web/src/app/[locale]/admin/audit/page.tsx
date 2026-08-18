import { setRequestLocale } from 'next-intl/server';
import type { AdminAuditListResponse } from '@/lib/admin';
import { buildAdminAuditQuery } from '@/lib/admin';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { AdminAuditClient } from './AdminAuditClient';

export default async function AdminAuditPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const token = await getTokenFromCookies();
  const res = await fetcher<AdminAuditListResponse>(
    `/api/admin/audit?${buildAdminAuditQuery({ page: 1, pageSize: 50 })}`,
    { token },
  );

  const initial: AdminAuditListResponse = res.ok
    ? res.data
    : { items: [], total: 0, page: 1, pageSize: 50 };

  return <AdminAuditClient locale={locale} initial={initial} />;
}
