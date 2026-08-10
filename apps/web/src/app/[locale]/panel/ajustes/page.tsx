import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { AjustesClient, type ClinicSettings } from './AjustesClient';

export default async function AjustesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.settings');

  const token = await getTokenFromCookies();
  const res = await fetcher<ClinicSettings>('/api/clinics/me', { token });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!res.ok ? (
        <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('loadError', { status: res.status })}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <AjustesClient clinic={res.data} />
        </div>
      )}
    </div>
  );
}
