import { ArrowLeft, CheckCircle2, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { ThanksName } from './ThanksName';

/**
 * Página de confirmación post-submit.
 *
 * Recibe `date` y `time` como query params — NO el `name`. El nombre viaja
 * por `sessionStorage` (ver B.4 del ADR `docs/adr/0004-pii-y-compliance.md`)
 * y lo renderiza `<ThanksName />` client-side.
 *
 * En Next 15 `searchParams` es un Promise → hay que awaitear.
 */
export default async function GraciasPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; clinicSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, clinicSlug } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);

  const t = await getTranslations('thanks');
  const date = typeof sp.date === 'string' ? sp.date : '';
  const time = typeof sp.time === 'string' ? sp.time : '';

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8">
      <Card className="w-full max-w-md shadow-sm">
        <CardContent className="p-8 text-center">
          {/* Icono principal — verde brand-600 sobre halo brand-50 para
              coherencia con el resto del panel. */}
          <div
            className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50"
            aria-hidden="true"
          >
            <CheckCircle2 className="h-9 w-9 text-brand-600" />
          </div>

          <ThanksName />

          {/* Detalle de la cita — fecha/hora resaltada en un chip visual */}
          <div className="mt-4 rounded-lg border border-brand-100 bg-brand-50/50 p-4">
            <p className="text-sm text-gray-700">
              {t('subtitle', { date, time })}
            </p>
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-md bg-gray-50 p-3 text-left text-xs text-gray-600">
            <MessageCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-gray-400"
              aria-hidden="true"
            />
            <p>{t('whatsappNote')}</p>
          </div>

          <Link
            href={`/${locale}/agendar/${clinicSlug}`}
            className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 transition-colors hover:text-brand-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 rounded-sm"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t('backLink')}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
