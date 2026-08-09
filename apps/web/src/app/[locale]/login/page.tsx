import { setRequestLocale } from 'next-intl/server';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { CalendarDays, MessageCircle, ShieldCheck, Sparkles } from 'lucide-react';
import { LoginForm } from './LoginForm';

/**
 * Login page — server component wrapper. La lógica del form vive en `LoginForm`
 * (client) para poder usar rhf + zod + fetch al backend.
 *
 * Layout desktop (≥lg): 2 columnas — brand panel a la izquierda + form a la derecha.
 * Mobile: single column con logo arriba + form centrado. El brand panel se oculta.
 *
 * `LoginForm` usa `useSearchParams()` (para leer `?next=`) — Next 15 exige
 * envolverlo en `<Suspense>` para no bailar del prerender.
 */
export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('login');

  return (
    <main className="grid min-h-screen grid-cols-1 bg-background lg:grid-cols-2">
      {/* Brand panel — solo desktop */}
      <aside
        className="relative hidden overflow-hidden bg-gradient-to-br from-brand-700 via-brand-700 to-brand-900 text-white lg:flex lg:flex-col"
        aria-hidden="true"
      >
        {/* Textura decorativa: retículo sutil + glow diagonal */}
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-400/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />

        <div className="relative flex h-full flex-col justify-between p-12">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 backdrop-blur-sm ring-1 ring-white/25">
              <Sparkles className="h-5 w-5 text-white" strokeWidth={2.25} />
            </div>
            <span className="text-lg font-semibold tracking-tight">AgendaZap</span>
          </div>

          {/* Copy central */}
          <div className="max-w-md">
            <h2 className="text-4xl font-semibold leading-tight tracking-tight">
              {t('brand.tagline')}
            </h2>
            <ul className="mt-10 space-y-5">
              <li className="flex items-start gap-3.5">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20">
                  <CalendarDays className="h-4 w-4" />
                </div>
                <span className="text-sm leading-relaxed text-white/90">
                  {t('brand.features.agenda')}
                </span>
              </li>
              <li className="flex items-start gap-3.5">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20">
                  <MessageCircle className="h-4 w-4" />
                </div>
                <span className="text-sm leading-relaxed text-white/90">
                  {t('brand.features.reminders')}
                </span>
              </li>
              <li className="flex items-start gap-3.5">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20">
                  <ShieldCheck className="h-4 w-4" />
                </div>
                <span className="text-sm leading-relaxed text-white/90">
                  {t('brand.features.public')}
                </span>
              </li>
            </ul>
          </div>

          {/* Footer */}
          <p className="text-xs text-white/60">{t('brand.footer')}</p>
        </div>
      </aside>

      {/* Form column */}
      <section className="flex items-center justify-center px-4 py-10 sm:px-8">
        <Suspense
          fallback={
            <div className="text-sm text-muted-foreground">…</div>
          }
        >
          <LoginForm locale={locale} />
        </Suspense>
      </section>
    </main>
  );
}
