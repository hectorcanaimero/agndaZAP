import { redirect } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { fetcher, getSession, getTokenFromCookies, type AuthMe } from '@/lib/auth';
import { AdminShell } from './AdminShell';

/**
 * Layout server component del Área SaaS Admin.
 *
 * Requisitos de acceso:
 * - Sesión activa con `role === 'SUPERADMIN'`.
 * - Si no hay sesión o el rol no es SUPERADMIN, redirige al login.
 *
 * Hace fetch a `/api/auth/me` para obtener el email del super y mostrarlo
 * en el header del AdminShell. Si el fetch falla (servicio caído, etc.),
 * se muestra el userId como fallback — no interrumpimos el flujo.
 *
 * Nota: la validación de rol en middleware es UX puro. Este layout es la
 * segunda línea de defensa a nivel de RSC — el backend sigue siendo la
 * fuente de verdad para cada endpoint.
 */
export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await getSession();

  // Sin sesión → login
  if (!session) {
    redirect(`/${locale}/login`);
  }

  // Solo SUPERADMIN accede al área admin
  if (session.role !== 'SUPERADMIN') {
    redirect(`/${locale}/panel/dashboard`);
  }

  const token = await getTokenFromCookies();
  const meRes = await fetcher<AuthMe>('/api/auth/me', { token });

  // 401 explícito del backend = sesión inválida (token revocado, secret
  // rotado). Redirigir a `/api/auth/force-logout` en vez de `/login`
  // directo: el handler server-side borra las cookies antes de mandar al
  // login, sino el middleware — que valida solo `exp` local, no la firma —
  // consideraría la cookie stale como "válida" y devolvería al admin,
  // generando ERR_TOO_MANY_REDIRECTS.
  //
  // NO redirigir en otros status (0 = network error / backend caído,
  // 500 = otro problema del backend) — degradamos con un email fallback.
  if (!meRes.ok && meRes.status === 401) {
    redirect(`/api/auth/force-logout?next=/${locale}/login`);
  }

  const displayEmail =
    meRes.ok && meRes.data?.email
      ? meRes.data.email
      : `id:${session.userId.slice(0, 8)}…`;

  return (
    <AdminShell locale={locale} email={displayEmail}>
      {children}
    </AdminShell>
  );
}
