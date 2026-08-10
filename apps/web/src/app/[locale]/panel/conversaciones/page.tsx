import { setRequestLocale } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { ConversationsClient, type ConversationListItem } from './ConversationsClient';

/**
 * Bandeja del panel. Full-bleed: la shell omite el contenedor para esta ruta
 * (ver `isFullBleedRoute` en PanelShell). El header, filtros y acciones viven
 * dentro del split view — no se renderiza título server-side acá.
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
    <ConversationsClient
      locale={locale}
      initialState={stateFilter}
      initialConversations={initial}
      initialError={!res.ok ? res.status : null}
    />
  );
}
