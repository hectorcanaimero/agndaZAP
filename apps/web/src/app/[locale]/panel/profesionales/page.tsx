import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { ProfessionalsClient } from './ProfessionalsClient';

interface Professional {
  id: string;
  name: string;
  active: boolean;
  services: Array<{ id: string; name: string }>;
}

interface ServiceLite {
  id: string;
  name: string;
}

export default async function ProfessionalsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.professionals');

  const token = await getTokenFromCookies();
  const [profsRes, servicesRes] = await Promise.all([
    fetcher<Professional[]>('/api/professionals', { token }),
    fetcher<ServiceLite[]>('/api/services', { token }),
  ]);

  return (
    <div className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500">{t('subtitle')}</p>
      </div>
      {!profsRes.ok ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {t('loadError', { status: profsRes.status })}
        </div>
      ) : null}
      <ProfessionalsClient
        professionals={profsRes.ok ? profsRes.data : []}
        services={servicesRes.ok ? servicesRes.data : []}
      />
    </div>
  );
}
