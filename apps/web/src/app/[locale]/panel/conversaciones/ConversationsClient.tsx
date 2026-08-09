'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MessageCircle,
  RefreshCw,
  Send,
  User,
  UserCheck,
  UserMinus,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { CONVERSATION_STATE_TOKENS } from '@/components/ui/tokens';
import { ApiError, apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

type ConvState = 'BOT' | 'NEEDS_HUMAN' | 'HUMAN';

export interface ConversationListItem {
  id: string;
  chatId: string;
  phone: string;
  state: ConvState;
  updatedAt: string;
  createdAt: string;
  messageCount: number;
  lastMessage: {
    id: string;
    direction: 'IN' | 'OUT';
    body: string;
    createdAt: string;
  } | null;
}

interface Message {
  id: string;
  direction: 'IN' | 'OUT';
  body: string;
  createdAt: string;
}

interface ConversationDetail extends ConversationListItem {
  messages: Message[];
}

interface Props {
  locale: string;
  initialState: string;
  initialConversations: ConversationListItem[];
}

const POLL_INTERVAL_MS = 15000;

/**
 * Sanitiza defensa-en-profundidad el reply antes de mandarlo. El backend
 * también sanitiza (control chars + trim + XSS defense), pero recortamos acá
 * también — no confiar solamente en un lado.
 */
function sanitizeReply(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim();
}

/**
 * queryFn para la lista de conversaciones. El filtro "inbox" es NEEDS_HUMAN +
 * HUMAN mergeado client-side (backend acepta un único `state`). Encapsulamos
 * la lógica acá para que useQuery reciba una función limpia.
 */
async function fetchConversations(
  stateFilter: string,
): Promise<ConversationListItem[]> {
  if (stateFilter === 'inbox') {
    const [a, b] = await Promise.all([
      apiQuery<ConversationListItem[]>(
        `/api/conversations?state=NEEDS_HUMAN`,
      ),
      apiQuery<ConversationListItem[]>(`/api/conversations?state=HUMAN`),
    ]);
    const merged = [...a, ...b];
    merged.sort(
      (x, y) =>
        new Date(y.updatedAt).getTime() - new Date(x.updatedAt).getTime(),
    );
    return merged;
  }
  if (stateFilter === 'all') {
    return apiQuery<ConversationListItem[]>(`/api/conversations`);
  }
  const qs = new URLSearchParams();
  if (stateFilter === 'BOT') qs.set('state', 'BOT');
  if (stateFilter === 'NEEDS_HUMAN') qs.set('state', 'NEEDS_HUMAN');
  if (stateFilter === 'HUMAN') qs.set('state', 'HUMAN');
  return apiQuery<ConversationListItem[]>(
    `/api/conversations?${qs.toString()}`,
  );
}

/**
 * Bandeja del panel. Layout: sidebar de conversaciones a la izquierda, panel de
 * detalle a la derecha. Polling cada 15s vía `refetchInterval` de useQuery —
 * reemplaza el setInterval manual y evita solapamientos si el server tarda.
 */
export function ConversationsClient({
  locale,
  initialState,
  initialConversations,
}: Props) {
  const t = useTranslations('panel.conversations');
  const qc = useQueryClient();

  const [stateFilter, setStateFilter] = useState<string>(initialState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  // Nota: previamente había un setInterval que forzaba re-render cada 5s para
  // recomputar el "hace Xs" del staleness indicator. Con TanStack Query el
  // `refetchInterval` de POLL_INTERVAL_MS ya dispara un re-render en cada
  // refetch — la label se actualiza cada 15s. Menos "vivo" que antes (pierde
  // el conteo intermedio 5s/10s), pero ganamos "cero setInterval" según spec
  // de rediseño y evitamos un timer paralelo al polling.

  /*
   * Lista de conversaciones. `initialData` sólo aplica cuando el filtro
   * actual matchea el `initialState` server-side — cambiar el filtro dispara
   * un fetch nuevo. `refetchInterval` sustituye el setInterval manual.
   */
  const conversationsQuery = useQuery({
    queryKey: queryKeys.conversations(stateFilter),
    queryFn: () => fetchConversations(stateFilter),
    initialData:
      stateFilter === initialState ? initialConversations : undefined,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const convos = conversationsQuery.data ?? [];
  const refreshing = conversationsQuery.isFetching;
  const lastRefreshAt = conversationsQuery.dataUpdatedAt
    ? new Date(conversationsQuery.dataUpdatedAt)
    : null;

  /*
   * Detalle de la conversación seleccionada. `enabled` gate — no dispara
   * fetch hasta que hay `selectedId`. `refetchInterval` también acá para que
   * lleguen mensajes nuevos entrantes sin refresh manual.
   */
  const detailQuery = useQuery({
    queryKey: queryKeys.conversation(selectedId ?? ''),
    queryFn: () =>
      apiQuery<ConversationDetail>(
        `/api/conversations/${selectedId}?limit=50`,
      ),
    enabled: !!selectedId,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const detail = detailQuery.data ?? null;
  const detailLoading = detailQuery.isLoading;

  const takeoverMutation = useMutation({
    mutationFn: (id: string) =>
      apiMutation<void>(`/api/conversations/${id}/takeover`, 'POST'),
    onSuccess: (_data, id) => {
      toast.success(t('takeoverOk'));
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: queryKeys.conversation(id) });
    },
    onError: () => {
      toast.error(t('takeoverFailed'));
    },
  });

  const releaseMutation = useMutation({
    mutationFn: (id: string) =>
      apiMutation<void>(`/api/conversations/${id}/release`, 'POST'),
    onSuccess: (_data, id) => {
      toast.success(t('releaseOk'));
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: queryKeys.conversation(id) });
    },
    onError: () => {
      toast.error(t('releaseFailed'));
    },
  });

  /*
   * Reply con optimistic UI:
   *   1. Si no estamos en HUMAN, disparamos takeover primero — si falla,
   *      abortamos (no reply).
   *   2. Escribimos el mensaje optimista en el cache del detail antes del POST.
   *   3. onSuccess: reemplazamos el tempId por el mensaje real del server.
   *   4. onError: rollback del cache + restauramos el texto en el textarea +
   *      toast de error. Verificado que el orden de setReply(prevText) es
   *      crítico para que el operador no pierda su texto.
   */
  const replyMutation = useMutation({
    mutationFn: async ({
      id,
      text,
    }: {
      id: string;
      text: string;
    }): Promise<{ id: string; body: string; createdAt: string }> => {
      return apiMutation<
        { id: string; body: string; createdAt: string },
        { text: string }
      >(`/api/conversations/${id}/reply`, 'POST', { text });
    },
    onMutate: async ({ id, text }) => {
      const detailKey = queryKeys.conversation(id);
      await qc.cancelQueries({ queryKey: detailKey });
      const snapshot = qc.getQueryData<ConversationDetail>(detailKey);
      const tempId = `tmp-${Date.now()}`;
      qc.setQueryData<ConversationDetail | undefined>(detailKey, (old) =>
        old
          ? {
              ...old,
              messages: [
                ...old.messages,
                {
                  id: tempId,
                  direction: 'OUT',
                  body: text,
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : old,
      );
      return { snapshot, tempId, prevReply: reply };
    },
    onSuccess: (data, { id }, ctx) => {
      const detailKey = queryKeys.conversation(id);
      // Reemplazar el mensaje optimista con el real (mismo tempId → data.id).
      qc.setQueryData<ConversationDetail | undefined>(detailKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          messages: old.messages.map((m) =>
            m.id === ctx?.tempId
              ? {
                  id: data.id,
                  body: data.body,
                  createdAt: data.createdAt,
                  direction: 'OUT',
                }
              : m,
          ),
        };
      });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (_err, { id }, ctx) => {
      const detailKey = queryKeys.conversation(id);
      // Rollback: si teníamos snapshot, lo restauramos. Si no, quitamos el temp.
      if (ctx?.snapshot) {
        qc.setQueryData(detailKey, ctx.snapshot);
      } else if (ctx?.tempId) {
        qc.setQueryData<ConversationDetail | undefined>(detailKey, (old) =>
          old
            ? {
                ...old,
                messages: old.messages.filter((m) => m.id !== ctx.tempId),
              }
            : old,
        );
      }
      // Restaurar el texto para que el operador no lo pierda.
      if (ctx?.prevReply !== undefined) setReply(ctx.prevReply);
      toast.error(t('replyFailed'));
    },
  });

  function takeOver() {
    if (!detail) return;
    takeoverMutation.mutate(detail.id);
  }

  function release() {
    if (!detail) return;
    releaseMutation.mutate(detail.id);
  }

  async function sendReply() {
    if (!detail || replyMutation.isPending) return;
    const text = sanitizeReply(reply);
    if (!text) {
      toast.error(t('replyEmpty'));
      return;
    }
    // Auto-takeover si aún no estamos en HUMAN. Si falla (409 u otro),
    // abortamos el send — NO llamamos al endpoint de reply — y avisamos.
    if (detail.state !== 'HUMAN') {
      try {
        await takeoverMutation.mutateAsync(detail.id);
      } catch (err) {
        // takeover ya muestra su propio error toast, pero el copy correcto acá
        // es "errors.takeoverFailed" — igual que antes.
        void err;
        toast.error(t('errors.takeoverFailed'));
        return;
      }
      // Actualizamos el detail localmente para que el resto del flujo sepa
      // que ya estamos en HUMAN. La invalidate del onSuccess de takeover
      // ya disparó refetch — este set es defensivo por si el fetch tarda.
      const detailKey = queryKeys.conversation(detail.id);
      qc.setQueryData<ConversationDetail | undefined>(detailKey, (old) =>
        old ? { ...old, state: 'HUMAN' } : old,
      );
    }

    // Limpiamos el textarea antes del mutate — el onError lo restaura si falla.
    setReply('');
    replyMutation.mutate(
      { id: detail.id, text },
      {
        onError: (err) => {
          void err;
          if (err instanceof ApiError) {
            // el rollback ya restauró el texto vía ctx.prevReply.
          }
        },
      },
    );
  }

  const canTakeOver = detail?.state === 'BOT' || detail?.state === 'NEEDS_HUMAN';
  const canRelease = detail?.state === 'HUMAN';
  const replying = replyMutation.isPending;

  return (
    <div className="grid gap-4 md:grid-cols-[320px_1fr]">
      {/* Sidebar de conversaciones */}
      <div className="space-y-3">
        <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
          <div className="flex flex-wrap gap-1">
            {(['inbox', 'BOT', 'HUMAN', 'all'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                  stateFilter === s
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-gray-600 hover:bg-gray-100',
                )}
                onClick={() => setStateFilter(s)}
              >
                {t(`filters.${s}` as const)}
              </button>
            ))}
          </div>
          {/*
            Staleness indicator. Recalcula el "hace Xs" cada 5s via `tick`
            (setInterval en useEffect). aria-live="off" para no spamear al
            screen reader — el operador visual lo mira; el screen reader
            recibe cambios importantes vía toast + role="status" con polite.
          */}
          <div className="mt-2 flex min-h-[1.25rem] items-center gap-1.5 px-1">
            {refreshing ? (
              <>
                <RefreshCw
                  className="h-3 w-3 animate-spin text-gray-400"
                  aria-hidden="true"
                />
                <span role="status" className="text-xs text-gray-500">
                  {t('refreshing')}
                </span>
              </>
            ) : lastRefreshAt ? (
              <Badge
                variant="outline"
                className="border-gray-200 bg-transparent px-1.5 py-0 text-[10px] font-normal text-gray-500"
                role="status"
                aria-live="off"
              >
                {t('lastRefresh', {
                  seconds: Math.floor(
                    (Date.now() - lastRefreshAt.getTime()) / 1000,
                  ),
                })}
              </Badge>
            ) : null}
          </div>
        </div>

        <ul className="max-h-[70vh] divide-y divide-gray-100 overflow-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          {convos.length === 0 ? (
            <li className="flex flex-col items-center justify-center p-8 text-center">
              <MessageCircle
                className="h-8 w-8 text-gray-300"
                aria-hidden="true"
              />
              <p className="mt-2 text-sm text-gray-500">
                {t('emptyList')}
              </p>
            </li>
          ) : (
            convos.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    'w-full px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
                    selectedId === c.id
                      ? 'bg-brand-50'
                      : 'hover:bg-gray-50',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium tabular-nums text-gray-900">
                      {c.phone}
                    </p>
                    <Badge
                      variant="outline"
                      className={CONVERSATION_STATE_TOKENS[c.state]}
                    >
                      {t(`state.${c.state}` as const)}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-gray-500">
                    {c.lastMessage?.body ?? '—'}
                  </p>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      {/* Panel de detalle */}
      <div className="flex min-h-[60vh] flex-col rounded-lg border border-gray-200 bg-white shadow-sm">
        {!detail ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <MessageCircle
              className="h-10 w-10 text-gray-300"
              aria-hidden="true"
            />
            <p className="mt-3 text-sm text-gray-500">{t('emptyDetail')}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100">
                  <User
                    className="h-5 w-5 text-gray-500"
                    aria-hidden="true"
                  />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold tabular-nums text-gray-900">
                    {detail.phone}
                  </p>
                  <p className="text-xs text-gray-500">
                    {t('messagesCount', { n: detail.messageCount })} ·{' '}
                    {t(`state.${detail.state}` as const)}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                {canTakeOver ? (
                  <Button size="sm" onClick={takeOver}>
                    <UserCheck
                      className="mr-1.5 h-4 w-4"
                      aria-hidden="true"
                    />
                    {t('takeover')}
                  </Button>
                ) : null}
                {canRelease ? (
                  <Button variant="ghost" size="sm" onClick={release}>
                    <UserMinus
                      className="mr-1.5 h-4 w-4"
                      aria-hidden="true"
                    />
                    {t('release')}
                  </Button>
                ) : null}
              </div>
            </div>

            <div
              className="flex-1 space-y-2 overflow-auto bg-gray-50/50 p-4"
              aria-busy={detailLoading}
            >
              {detailLoading ? (
                // Skeleton: 3 bubbles alternando lado (shadcn Skeleton = animate-pulse).
                [0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className={cn(
                      'flex',
                      i % 2 === 0 ? 'justify-start' : 'justify-end',
                    )}
                    aria-hidden="true"
                  >
                    <Skeleton
                      className={cn(
                        'h-12 rounded-2xl',
                        i % 2 === 0 ? 'w-2/3' : 'w-1/2',
                      )}
                    />
                  </div>
                ))
              ) : (
                detail.messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    direction={m.direction}
                    body={m.body}
                    createdAt={m.createdAt}
                    locale={locale}
                  />
                ))
              )}
            </div>

            <div className="border-t border-gray-100 bg-white p-3">
              {/*
                Textarea SIEMPRE editable (spec §Propuesta.2). El operador puede
                pre-escribir mientras el paciente sigue con el bot; el auto-takeover
                se dispara en el click de Enviar. `aria-describedby` conecta el
                hint contextual cuando aplica (screen reader lo asocia al input).
              */}
              <Textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={t('replyPlaceholder')}
                maxLength={1500}
                className="min-h-[80px] resize-none"
                aria-describedby={
                  detail.state !== 'HUMAN' ? 'reply-hint' : undefined
                }
              />
              {detail.state !== 'HUMAN' ? (
                // Hint contextual pegado al textarea (no al fondo del panel).
                // Contraste text-orange-700 (#c2410c) on white = 4.83:1 → AA.
                <p
                  id="reply-hint"
                  role="note"
                  className="mt-1.5 text-xs text-orange-700"
                >
                  {t('autoTakeoverHint')}
                </p>
              ) : null}
              <div className="mt-2 flex items-center justify-between">
                <p className="text-xs text-gray-500">{t('sendHint')}</p>
                <Button
                  size="sm"
                  disabled={replying || !reply.trim()}
                  aria-describedby={
                    detail.state !== 'HUMAN' ? 'reply-hint' : undefined
                  }
                  onClick={sendReply}
                >
                  {replying ? (
                    <>
                      <RefreshCw
                        className="mr-1.5 h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                      {t('sending')}
                    </>
                  ) : (
                    <>
                      <Send
                        className="mr-1.5 h-4 w-4"
                        aria-hidden="true"
                      />
                      {t('send')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MessageBubble({
  direction,
  body,
  createdAt,
  locale,
}: {
  direction: 'IN' | 'OUT';
  body: string;
  createdAt: string;
  locale: string;
}) {
  const isIn = direction === 'IN';
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(createdAt));

  return (
    <div className={cn('flex', isIn ? 'justify-start' : 'justify-end')}>
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm whitespace-pre-wrap break-words',
          isIn
            ? 'rounded-bl-sm border border-gray-200 bg-white text-gray-900'
            : // bg-brand-600 (era bg-brand-500) — sube contraste sobre texto
              // blanco a 4.83:1, cumple WCAG AA. Ver spec design-system-tokens.
              'rounded-br-sm bg-brand-600 text-white',
        )}
      >
        <p>{body}</p>
        <p
          className={cn(
            'mt-1 text-[10px] tabular-nums',
            isIn ? 'text-gray-500' : 'text-white/80',
          )}
        >
          {time}
        </p>
      </div>
    </div>
  );
}
