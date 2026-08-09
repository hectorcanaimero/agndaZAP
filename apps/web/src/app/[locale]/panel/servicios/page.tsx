import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { ServicesClient } from './ServicesClient';

interface Service {
  id: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  priceCents: number | null;
  active: boolean;
  professionals: Array<{ id: string; name: string }>;
}

interface Professional {
  id: string;
  name: string;
}

export default async function ServicesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.services');

  const token = await getTokenFromCookies();
  const [servicesRes, profsRes] = await Promise.all([
    fetcher<Service[]>('/api/services', { token }),
    fetcher<Professional[]>('/api/professionals', { token }),
  ]);

  const services = servicesRes.ok ? servicesRes.data : [];
  const professionals = profsRes.ok ? profsRes.data : [];

  return (
    <div className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500">{t('subtitle')}</p>
      </div>

      {!servicesRes.ok ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {t('loadError', { status: servicesRes.status })}
        </div>
      ) : null}

      <ServicesClient services={services} professionals={professionals} />
    </div>
  );
}
