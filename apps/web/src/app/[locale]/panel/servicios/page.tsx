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

  // Full-height split layout (mismo patrón que agenda/conversaciones):
  // header page-level arriba, split master-detail ocupando el resto.
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!servicesRes.ok ? (
        <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('loadError', { status: servicesRes.status })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <ServicesClient services={services} professionals={professionals} />
      </div>
    </div>
  );
}
