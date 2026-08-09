import { getTranslations, setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
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
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md rounded-lg bg-white p-8 text-center shadow-sm">
        <ThanksName />
        <p className="mt-3 text-gray-700">{t('subtitle', { date, time })}</p>
        <p className="mt-2 text-sm text-gray-500">{t('whatsappNote')}</p>
        <Link
          href={`/${locale}/agendar/${clinicSlug}`}
          className="mt-6 inline-block text-brand-600 hover:underline"
        >
          {t('backLink')}
        </Link>
      </div>
    </main>
  );
}
