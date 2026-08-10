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
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!toffRes.ok ? (
        <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('loadError', { status: toffRes.status })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <TimeOffClient
          locale={locale}
          rows={toffRes.ok ? toffRes.data : []}
          professionals={profsRes.ok ? profsRes.data : []}
        />
      </div>
    </div>
  );
}
