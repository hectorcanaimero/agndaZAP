import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { FaqClient } from './FaqClient';

interface FaqChunk {
  id: string;
  content: string;
  createdAt: string;
}

export default async function FaqPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.faq');

  const token = await getTokenFromCookies();
  const res = await fetcher<FaqChunk[]>('/api/faq', { token });

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500">{t('subtitle')}</p>
      </div>
      {!res.ok ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {t('loadError', { status: res.status })}
        </div>
      ) : null}
      <FaqClient locale={locale} rows={res.ok ? res.data : []} />
    </div>
  );
}
