import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import {
  WhatsappConnectionClient,
  type WahaStatusResponse,
} from './WhatsappConnectionClient';

/**
 * SSR — trae el estado actual de la sesión WAHA de la clínica del usuario.
 *
 * Alineado con el patrón de `panel/servicios/page.tsx`: token desde el cookie
 * server-side, `fetcher` con manejo de 401 delegado al helper, y render de
 * error inline si el backend devuelve algo != 200.
 *
 * Las acciones y el polling adaptativo llegan en T5 (`WhatsappConnectionClient`).
 */
export default async function WhatsappConnectionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.whatsapp');

  const token = await getTokenFromCookies();
  const statusRes = await fetcher<WahaStatusResponse>(
    '/api/clinics/me/waha/status',
    { token },
  );

  // Si falla, mostramos el estado UNKNOWN + session vacío para que el client
  // component pueda seguir renderizando la UI (badge + botones). No rompe la
  // navegación — el próximo intento (T5) va a repolear.
  const initial: WahaStatusResponse = statusRes.ok
    ? statusRes.data
    : { status: 'UNKNOWN', session: '' };

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500">{t('subtitle')}</p>
      </div>

      {!statusRes.ok ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {t('loadError', { status: statusRes.status })}
        </div>
      ) : null}

      <WhatsappConnectionClient initial={initial} token={token ?? ''} />
    </div>
  );
}
