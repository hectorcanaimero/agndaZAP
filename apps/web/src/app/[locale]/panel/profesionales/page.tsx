import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { ProfessionalsClient } from './ProfessionalsClient';

interface Professional {
  id: string;
  name: string;
  active: boolean;
  email: string | null;
  phone: string | null;
  specialty: string | null;
  bio: string | null;
  avatarUrl: string | null;
  licenseNumber: string | null;
  color: string | null;
  followUpEnabled: boolean;
  followUpDelayHours: number;
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

  // Full-height split layout (mismo patrón que agenda/conversaciones/servicios).
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!profsRes.ok ? (
        <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('loadError', { status: profsRes.status })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <ProfessionalsClient
          professionals={profsRes.ok ? profsRes.data : []}
          services={servicesRes.ok ? servicesRes.data : []}
        />
      </div>
    </div>
  );
}
