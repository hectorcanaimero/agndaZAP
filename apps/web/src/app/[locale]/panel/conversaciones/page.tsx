import { getTranslations, setRequestLocale } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { ConversationsClient, type ConversationListItem } from './ConversationsClient';

/**
 * Bandeja del panel. Header page-level (title + subtitle) siguiendo el patrón
 * de las otras rutas del panel (agenda, servicios, etc.). El split view con
 * lista/chat/detalle vive dentro del ConversationsClient.
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
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="min-h-0 flex-1">
        <ConversationsClient
          locale={locale}
          initialState={stateFilter}
          initialConversations={initial}
          initialError={!res.ok ? res.status : null}
        />
      </div>
    </div>
  );
}
