import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { AjustesClient, type ClinicSettings } from './AjustesClient';
import type { WahaStatusResponse } from '../config/whatsapp/WhatsappConnectionClient';

/**
 * SSR — trae en paralelo el settings de la clínica y el estado actual de la
 * sesión WAHA (para hidratar el tab WhatsApp sin flash de loading).
 *
 * El estado WhatsApp lo pasamos al `AjustesClient` para que renderee el tab
 * correspondiente. Si falla, `AjustesClient` cae al fallback UNKNOWN — el
 * polling del `WhatsappConnectionClient` se recupera solo.
 */
export default async function AjustesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.settings');

  const token = await getTokenFromCookies();
  const [clinicRes, wahaRes] = await Promise.all([
    fetcher<ClinicSettings>('/api/clinics/me', { token }),
    fetcher<WahaStatusResponse>('/api/clinics/me/waha/status', { token }),
  ]);

  const wahaInitial: WahaStatusResponse = wahaRes.ok
    ? wahaRes.data
    : { status: 'UNKNOWN', session: '' };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!clinicRes.ok ? (
        <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('loadError', { status: clinicRes.status })}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <AjustesClient
            clinic={clinicRes.data}
            wahaInitial={wahaInitial}
            token={token ?? ''}
          />
        </div>
      )}
    </div>
  );
}
