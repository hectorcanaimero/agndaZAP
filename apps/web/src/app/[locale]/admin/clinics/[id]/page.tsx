import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { AdminClinicDetail } from '@/lib/admin';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { AdminClinicDetailClient } from './AdminClinicDetailClient';

/**
 * Server Component: fetch inicial del detalle + métricas. Si el backend
 * devuelve 404, disparamos `notFound()` para que Next renderice la página
 * default de 404 (con el layout admin intacto arriba).
 */
export default async function AdminClinicDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const token = await getTokenFromCookies();
  const res = await fetcher<AdminClinicDetail>(`/api/admin/clinics/${id}`, {
    token,
  });

  if (!res.ok) {
    if (res.status === 404) notFound();
    // Otros errores: seguimos con un shell mínimo — pero es raro (el layout
    // ya validó el token). Preferimos fallar hacia notFound para no exponer
    // detalles del backend caído en la UI.
    notFound();
  }

  return (
    <AdminClinicDetailClient locale={locale} clinicId={id} initial={res.data} />
  );
}
