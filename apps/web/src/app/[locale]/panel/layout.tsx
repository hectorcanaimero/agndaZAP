import { redirect } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { fetcher, getSession, getTokenFromCookies, type AuthMe } from '@/lib/auth';
import { PanelShell } from './PanelShell';

/**
 * Layout server component del panel:
 * 1. Chequea sesión — sin ella, redirige al login.
 * 2. Trae `GET /api/auth/me` para renderizar nombre + clínica en el sidebar.
 *    Si 401 → sesión inválida → login.
 * 3. Envuelve todo en `PanelShell` (client) que maneja sidebar + header.
 */
export default async function PanelLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await getSession();
  if (!session) {
    redirect(`/${locale}/login`);
  }

  const token = await getTokenFromCookies();
  const meRes = await fetcher<AuthMe>('/api/auth/me', { token });

  if (!meRes.ok) {
    // Backend rechazó el token (revocado, secret rotado, etc.) → limpiar
    // cookies server-side antes de ir al login. Sin el force-logout el
    // middleware — que valida solo `exp`, no la firma — devolvería al
    // panel y generaría ERR_TOO_MANY_REDIRECTS. Ver
    // apps/web/src/app/api/auth/force-logout/route.ts.
    if (meRes.status === 401) {
      redirect(`/api/auth/force-logout?next=/${locale}/login`);
    }
    // Otros errores (0 = backend caído, 500 = interno): degradamos con el
    // shell mínimo derivado del JWT decodificado. No ideal, pero evita
    // tumbar el panel si `/auth/me` está caído momentáneamente.
  }

  const me: AuthMe =
    meRes.ok && meRes.data
      ? meRes.data
      : {
          id: session.userId,
          email: '',
          name: '—',
          role: session.role,
          clinic: null,
        };

  // `impersonatedBy` viene del claim del JWT decodificado en el middleware/
  // layout. Es la señal para mostrar el ImpersonationBanner. Lo derivamos de
  // la sesión (no de /auth/me) porque es un dato del token, no del usuario.
  const isImpersonating = Boolean(session.impersonatedBy);

  return (
    <PanelShell locale={locale} me={me} isImpersonating={isImpersonating}>
      {children}
    </PanelShell>
  );
}
