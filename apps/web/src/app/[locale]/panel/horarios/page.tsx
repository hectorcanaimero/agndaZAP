import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { BusinessHoursClient } from './BusinessHoursClient';

interface BusinessHour {
  id: string;
  weekday: number;
  startMinutes: number;
  endMinutes: number;
  professionalId: string | null;
}

interface ProfessionalLite {
  id: string;
  name: string;
}

export default async function BusinessHoursPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.businessHours');

  const token = await getTokenFromCookies();
  const [hoursRes, profsRes] = await Promise.all([
    fetcher<BusinessHour[]>('/api/business-hours', { token }),
    fetcher<ProfessionalLite[]>('/api/professionals', { token }),
  ]);

  return (
    <div className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500">{t('subtitle')}</p>
      </div>
      {!hoursRes.ok ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {t('loadError', { status: hoursRes.status })}
        </div>
      ) : null}
      <BusinessHoursClient
        hours={hoursRes.ok ? hoursRes.data : []}
        professionals={profsRes.ok ? profsRes.data : []}
      />
    </div>
  );
}
