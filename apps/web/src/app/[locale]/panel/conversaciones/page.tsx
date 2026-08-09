import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { ConversationsClient, type ConversationListItem } from './ConversationsClient';

/**
 * Bandeja del panel. Server-fetch inicial de las conversaciones NEEDS_HUMAN +
 * HUMAN (bandeja de trabajo del recepcionista). El cliente permite togglear
 * `BOT` y polling cada 15s.
 */
export default async function ConversationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations('panel.conversations');

  const stateFilter = sp.state ?? 'inbox';
  const token = await getTokenFromCookies();

  // Backend acepta un único `state`. El toggle "inbox" es NEEDS_HUMAN + HUMAN
  // — pedimos NEEDS_HUMAN acá y el cliente pide HUMAN aparte (o pedimos ambos
  // client-side al montar). Para mantener SSR simple, sólo pedimos NEEDS_HUMAN
  // en el inicial; el cliente hace merge con HUMAN post-mount.
  const initialState = stateFilter === 'all' ? undefined : 'NEEDS_HUMAN';

  const qs = new URLSearchParams();
  if (initialState) qs.set('state', initialState);

  const res = await fetcher<ConversationListItem[]>(
    `/api/conversations${qs.toString() ? `?${qs.toString()}` : ''}`,
    { token },
  );

  const initial = res.ok ? res.data : [];

  return (
    <div className="max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500">{t('subtitle')}</p>
      </div>

      {!res.ok ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {t('loadError', { status: res.status })}
        </div>
      ) : null}

      <ConversationsClient
        locale={locale}
        initialState={stateFilter}
        initialConversations={initial}
      />
    </div>
  );
}
