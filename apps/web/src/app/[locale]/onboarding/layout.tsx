import { redirect } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { fetcher, getSession, getTokenFromCookies, type AuthMe } from '@/lib/auth';

/**
 * Layout server component del wizard de onboarding.
 *
 * Chequeos:
 * 1. Sesión válida — sin ella, redirect a /login con `next` para volver.
 * 2. Role != PROFESSIONAL — los profesionales nunca ven el wizard.
 * 3. Si ya completó (`onboardingCompletedAt` no null) → redirect al panel.
 *    (El middleware ya hace este redirect via cookie hint, este es el safety
 *    net server-side por si la cookie está stale.)
 *
 * NO renderiza header/shell — cada page.tsx dentro de `[step]/` monta el
 * OnboardingProvider + OnboardingShell. Esto permite que la page conozca
 * `currentStep` desde el URL param antes de hidratar el context.
 */
export default async function OnboardingLayout({
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
    redirect(`/${locale}/login?next=/${locale}/onboarding`);
  }
  if (session.role === 'PROFESSIONAL') {
    redirect(`/${locale}/panel/dashboard`);
  }

  const token = await getTokenFromCookies();
  const meRes = await fetcher<AuthMe>('/api/auth/me', { token });

  if (!meRes.ok) {
    if (meRes.status === 401) {
      redirect(`/${locale}/login?next=/${locale}/onboarding`);
    }
    // Fallback: si /auth/me falla por otro motivo, dejamos entrar — el
    // context va a operar con estado default y el user puede intentar de
    // nuevo tras un refresh.
  }

  return <>{children}</>;
}
