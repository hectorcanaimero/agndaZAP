import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { TimeOffClient } from './TimeOffClient';

interface TimeOff {
  id: string;
  startAt: string;
  endAt: string;
  reason: string | null;
  professionalId: string | null;
}

interface ProfessionalLite {
  id: string;
  name: string;
}

export default async function TimeOffPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.timeOff');

  const token = await getTokenFromCookies();
  const [toffRes, profsRes] = await Promise.all([
    fetcher<TimeOff[]>('/api/time-off', { token }),
    fetcher<ProfessionalLite[]>('/api/professionals', { token }),
  ]);

  return (
    <div className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500">{t('subtitle')}</p>
      </div>
      {!toffRes.ok ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {t('loadError', { status: toffRes.status })}
        </div>
      ) : null}
      <TimeOffClient
        locale={locale}
        rows={toffRes.ok ? toffRes.data : []}
        professionals={profsRes.ok ? profsRes.data : []}
      />
    </div>
  );
}
