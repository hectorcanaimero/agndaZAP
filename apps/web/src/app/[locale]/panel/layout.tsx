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
    // Backend rechazó el token (revocado, secret rotado, etc.) → login.
    if (meRes.status === 401) {
      redirect(`/${locale}/login`);
    }
    // Otros errores: mostramos un shell mínimo con lo que sabemos del JWT
    // decodificado — no ideal, pero evita romper el flujo si `/auth/me` está
    // caído momentáneamente.
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

  return (
    <PanelShell locale={locale} me={me}>
      {children}
    </PanelShell>
  );
}
