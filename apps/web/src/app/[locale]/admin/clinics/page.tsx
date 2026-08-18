import { setRequestLocale } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import type { AdminClinicsListResponse } from '@/lib/admin';
import { buildAdminClinicsQuery } from '@/lib/admin';
import { AdminClinicsClient } from './AdminClinicsClient';

/**
 * Server Component: hace el fetch inicial de la primera página sin filtros
 * y se lo pasa al client component como `initialData`. Cualquier cambio en
 * filtros/página después de la hidratación va por TanStack Query en el cliente.
 *
 * Si el fetch inicial falla, pasamos una respuesta vacía — el client mostrará
 * el estado vacío y ofrecerá el botón "Reintentar".
 */
export default async function AdminClinicsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const token = await getTokenFromCookies();
  const initialQuery = buildAdminClinicsQuery({ page: 1, pageSize: 20 });
  const res = await fetcher<AdminClinicsListResponse>(
    `/api/admin/clinics?${initialQuery}`,
    { token },
  );

  const initial: AdminClinicsListResponse = res.ok
    ? res.data
    : { items: [], total: 0, page: 1, pageSize: 20 };

  return <AdminClinicsClient locale={locale} initial={initial} />;
}
