'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  Inbox,
  Loader2,
  MessageCircle,
  MessageSquareText,
  Phone,
  Search,
  Send,
  Sparkles,
  UserCheck,
  UserMinus,
  UserRound,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
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
  initialError: number | null;
}

const POLL_INTERVAL_MS = 15000;
const MAX_REPLY_LEN = 1500;
const REPLY_COUNTER_THRESHOLD = 1200;

/** Sanitiza defensa-en-profundidad el reply antes de mandarlo. */
function sanitizeReply(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim();
}

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
 * Bandeja del panel — rediseño full-viewport tri-column.
 *
 *  - Columna izquierda (bandeja): buscador + filtros + lista.
 *  - Columna central (chat): header con paciente + mensajes + composer.
 *  - Columna derecha (xl+): panel de contacto y actividad.
 *
 * Layout responsive: 1 col en mobile (drawer para volver a la lista),
 * 2 cols en lg (sin panel derecho), 3 cols en xl+.
 */
export function ConversationsClient({
  locale,
  initialState,
  initialConversations,
  initialError,
}: Props) {
  const t = useTranslations('panel.conversations');
  const qc = useQueryClient();

  const [stateFilter, setStateFilter] = useState<string>(initialState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [search, setSearch] = useState('');

  const searchInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  /* Lista de conversaciones — polling cada 15s. */
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

  /* Filtrado client-side por búsqueda (teléfono o body del último mensaje). */
  const filteredConvos = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return convos;
    return convos.filter(
      (c) =>
        c.phone.toLowerCase().includes(q) ||
        (c.lastMessage?.body ?? '').toLowerCase().includes(q),
    );
  }, [convos, search]);

  /* Contadores por estado — usados en las pills de filtro. */
  const counts = useMemo(
    () => ({
      inbox: convos.filter((c) => c.state !== 'BOT').length,
      BOT: convos.filter((c) => c.state === 'BOT').length,
      HUMAN: convos.filter((c) => c.state === 'HUMAN').length,
      NEEDS_HUMAN: convos.filter((c) => c.state === 'NEEDS_HUMAN').length,
      all: convos.length,
    }),
    [convos],
  );

  /* Detalle. */
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
      if (ctx?.prevReply !== undefined) setReply(ctx.prevReply);
      toast.error(t('replyFailed'));
    },
  });

  const takeOver = useCallback(() => {
    if (!detail) return;
    takeoverMutation.mutate(detail.id);
  }, [detail, takeoverMutation]);

  const release = useCallback(() => {
    if (!detail) return;
    releaseMutation.mutate(detail.id);
  }, [detail, releaseMutation]);

  const sendReply = useCallback(async () => {
    if (!detail || replyMutation.isPending) return;
    const text = sanitizeReply(reply);
    if (!text) {
      toast.error(t('replyEmpty'));
      return;
    }
    if (detail.state !== 'HUMAN') {
      try {
        await takeoverMutation.mutateAsync(detail.id);
      } catch (err) {
        void err;
        toast.error(t('errors.takeoverFailed'));
        return;
      }
      const detailKey = queryKeys.conversation(detail.id);
      qc.setQueryData<ConversationDetail | undefined>(detailKey, (old) =>
        old ? { ...old, state: 'HUMAN' } : old,
      );
    }
    setReply('');
    replyMutation.mutate(
      { id: detail.id, text },
      {
        onError: (err) => {
          void err;
          if (err instanceof ApiError) {
            // rollback via ctx.prevReply
          }
        },
      },
    );
  }, [detail, replyMutation, takeoverMutation, reply, qc, t]);

  const canTakeOver = detail?.state === 'BOT' || detail?.state === 'NEEDS_HUMAN';
  const canRelease = detail?.state === 'HUMAN';
  const replying = replyMutation.isPending;

  /* Keyboard shortcut: ⌘K / Ctrl+K enfoca el buscador. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Auto-scroll al último mensaje cuando entra uno nuevo. */
  useEffect(() => {
    if (!detail) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.messages.length, detail]);

  /* Composer: ⌘Enter / Ctrl+Enter envía. */
  const onComposerKey = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void sendReply();
      }
    },
    [sendReply],
  );

  /* Textarea auto-grow (cap 200px). */
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [reply]);

  const displayError = initialError;
  const showBackToList = !!selectedId;

  return (
    <div
      className={cn(
        'grid h-full min-h-0 w-full bg-[#fbfbfa] text-neutral-900',
        'grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)_380px]',
        'font-[family-name:var(--font-conv-sans)]',
      )}
    >
      {/* ═════════ COLUMNA IZQUIERDA — BANDEJA ═════════ */}
      <aside
        className={cn(
          'flex min-h-0 flex-col border-r border-neutral-200/70 bg-white/60 backdrop-blur-sm',
          'animate-in fade-in slide-in-from-left-2 duration-300',
          // En mobile: si hay conversación seleccionada, ocultá la lista.
          selectedId ? 'hidden lg:flex' : 'flex',
        )}
      >
        {/* Header con título + estado */}
        <div className="border-b border-neutral-200/70 px-5 pt-6 pb-4">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="flex items-baseline gap-2 font-[family-name:var(--font-conv-display)] text-[28px] font-medium leading-none tracking-tight text-neutral-900">
              {t('title')}
              <span className="font-[family-name:var(--font-conv-mono)] text-[13px] font-normal text-neutral-400 tabular-nums">
                {convos.length}
              </span>
            </h1>
            <div className="flex h-5 items-center">
              {refreshing ? (
                <Loader2
                  aria-label={t('refreshing')}
                  className="h-3.5 w-3.5 animate-spin text-neutral-400"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]"
                />
              )}
            </div>
          </div>
          <p className="mt-1 text-[13px] text-neutral-500">{t('subtitle')}</p>
        </div>

        {/* Buscador */}
        <div className="px-4 pt-4">
          <div className="group relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400 transition-colors group-focus-within:text-brand-600"
            />
            <input
              ref={searchInputRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className={cn(
                'h-10 w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-14 text-sm text-neutral-900 placeholder:text-neutral-400',
                'transition-shadow focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/10',
              )}
            />
            <kbd
              aria-hidden="true"
              className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-[family-name:var(--font-conv-mono)] text-[10px] font-medium text-neutral-500 md:flex"
            >
              ⌘K
            </kbd>
          </div>
        </div>

        {/* Filtros segmented */}
        <div className="px-4 pt-3">
          <div
            role="tablist"
            aria-label={t('filters.inbox')}
            className="flex items-center gap-1 rounded-lg bg-neutral-100/80 p-1"
          >
            {(['inbox', 'BOT', 'HUMAN', 'all'] as const).map((s) => {
              const active = stateFilter === s;
              const n = counts[s];
              return (
                <button
                  key={s}
                  role="tab"
                  aria-selected={active}
                  type="button"
                  onClick={() => setStateFilter(s)}
                  className={cn(
                    'group relative flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium transition-all',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1',
                    active
                      ? 'bg-white text-neutral-900 shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                      : 'text-neutral-500 hover:text-neutral-800',
                  )}
                >
                  <span>{t(`filters.${s}`)}</span>
                  {n > 0 ? (
                    <span
                      className={cn(
                        'font-[family-name:var(--font-conv-mono)] text-[10px] tabular-nums',
                        active ? 'text-brand-600' : 'text-neutral-400',
                      )}
                    >
                      {n}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* Lista */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
          {displayError && convos.length === 0 ? (
            <div className="mx-2 mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800">
              {t('loadError', { status: displayError })}
            </div>
          ) : null}
          {conversationsQuery.isLoading && convos.length === 0 ? (
            <ConversationSkeletons />
          ) : filteredConvos.length === 0 ? (
            <EmptyList search={search} t={t} />
          ) : (
            <ul className="space-y-0.5">
              {filteredConvos.map((c) => (
                <ConversationListRow
                  key={c.id}
                  conv={c}
                  selected={selectedId === c.id}
                  onSelect={() => setSelectedId(c.id)}
                  locale={locale}
                  t={t}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* ═════════ COLUMNA CENTRAL — CHAT ═════════ */}
      <section
        className={cn(
          'relative flex min-h-0 flex-col bg-white',
          'animate-in fade-in slide-in-from-bottom-1 duration-300 [animation-delay:60ms] [animation-fill-mode:backwards]',
          !selectedId ? 'hidden lg:flex' : 'flex',
        )}
      >
        {!detail && !detailLoading ? (
          <EmptyChat t={t} />
        ) : detailLoading && !detail ? (
          <ChatSkeleton />
        ) : detail ? (
          <>
            {/* Header chat */}
            <header className="flex items-center gap-3 border-b border-neutral-200/70 bg-white/95 px-4 py-3 backdrop-blur-sm md:px-6 md:py-4">
              {showBackToList ? (
                <button
                  type="button"
                  aria-label={t('backToList')}
                  onClick={() => setSelectedId(null)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 lg:hidden"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
              <ContactAvatar phone={detail.phone} state={detail.state} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-[family-name:var(--font-conv-display)] text-[19px] font-medium leading-tight tracking-tight text-neutral-900">
                  {formatPhone(detail.phone)}
                </p>
                <p className="mt-0.5 flex items-center gap-2 text-[12px] text-neutral-500">
                  <StateDot state={detail.state} />
                  <span>{t(`state.${detail.state}`)}</span>
                  <span className="text-neutral-300">·</span>
                  <span className="font-[family-name:var(--font-conv-mono)] tabular-nums">
                    {t('messagesCount', { n: detail.messageCount })}
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                {canTakeOver ? (
                  <Button
                    size="sm"
                    onClick={takeOver}
                    disabled={takeoverMutation.isPending}
                    className="bg-brand-600 hover:bg-brand-700"
                  >
                    <UserCheck className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    {t('takeover')}
                  </Button>
                ) : null}
                {canRelease ? (
                  <Button variant="outline" size="sm" onClick={release}>
                    <UserMinus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    {t('release')}
                  </Button>
                ) : null}
              </div>
            </header>

            {/* Mensajes */}
            <div
              className="relative min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_top,_rgba(22,163,74,0.02),_transparent_40%)] px-4 py-6 md:px-8 md:py-8"
              aria-busy={detailLoading}
            >
              <div className="mx-auto flex max-w-3xl flex-col gap-3">
                {detailLoading && detail.messages.length === 0
                  ? [0, 1, 2, 3].map((i) => (
                      <MessageBubbleSkeleton key={i} inbound={i % 2 === 0} />
                    ))
                  : renderMessagesWithSeparators(detail.messages, locale)}
                <div ref={messagesEndRef} aria-hidden="true" />
              </div>
            </div>

            {/* Composer */}
            <footer className="border-t border-neutral-200/70 bg-white px-4 py-3 md:px-8 md:py-4">
              <div className="mx-auto max-w-3xl">
                <div
                  className={cn(
                    'group relative rounded-2xl border border-neutral-200 bg-white transition-all',
                    'focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/10',
                  )}
                >
                  <Textarea
                    ref={composerRef}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={onComposerKey}
                    placeholder={t('replyPlaceholder')}
                    maxLength={MAX_REPLY_LEN}
                    rows={1}
                    className="min-h-[52px] resize-none border-0 bg-transparent px-4 py-3.5 text-[14px] text-neutral-900 shadow-none focus-visible:ring-0"
                    aria-describedby={
                      detail.state !== 'HUMAN' ? 'reply-hint' : undefined
                    }
                  />
                  <div className="flex items-center justify-between gap-3 border-t border-neutral-100 px-3 py-2">
                    <div className="flex items-center gap-2 text-[11px] text-neutral-500">
                      {detail.state !== 'HUMAN' ? (
                        <span
                          id="reply-hint"
                          role="note"
                          className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-amber-800"
                        >
                          <Sparkles className="h-3 w-3" aria-hidden="true" />
                          {t('autoTakeoverHint')}
                        </span>
                      ) : (
                        <span className="hidden md:inline">
                          {t('composerHint')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      {reply.length >= REPLY_COUNTER_THRESHOLD ? (
                        <span
                          className={cn(
                            'font-[family-name:var(--font-conv-mono)] text-[11px] tabular-nums',
                            reply.length > MAX_REPLY_LEN - 100
                              ? 'text-red-600'
                              : 'text-neutral-400',
                          )}
                        >
                          {reply.length}/{MAX_REPLY_LEN}
                        </span>
                      ) : null}
                      <kbd
                        aria-hidden="true"
                        className="hidden items-center gap-1 rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-[family-name:var(--font-conv-mono)] text-[10px] font-medium text-neutral-500 md:inline-flex"
                      >
                        ⌘↵
                      </kbd>
                      <Button
                        size="sm"
                        disabled={replying || !reply.trim()}
                        onClick={sendReply}
                        className="bg-brand-600 hover:bg-brand-700"
                      >
                        {replying ? (
                          <Loader2
                            className="mr-1.5 h-3.5 w-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Send
                            className="mr-1.5 h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                        )}
                        {replying ? t('sending') : t('send')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </footer>
          </>
        ) : null}
      </section>

      {/* ═════════ COLUMNA DERECHA — DETALLE CONTACTO ═════════ */}
      <aside
        className={cn(
          'hidden min-h-0 flex-col border-l border-neutral-200/70 bg-[#f7f6f2] xl:flex',
          'animate-in fade-in slide-in-from-right-2 duration-300 [animation-delay:120ms] [animation-fill-mode:backwards]',
        )}
      >
        {detail ? (
          <ContactPanel detail={detail} locale={locale} t={t} />
        ) : (
          <ContactPanelEmpty t={t} />
        )}
      </aside>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════ */
/*  Sub-componentes                                                           */
/* ═════════════════════════════════════════════════════════════════════════ */

function ConversationListRow({
  conv,
  selected,
  onSelect,
  locale,
  t,
}: {
  conv: ConversationListItem;
  selected: boolean;
  onSelect: () => void;
  locale: string;
  t: ReturnType<typeof useTranslations<'panel.conversations'>>;
}) {
  const last = conv.lastMessage;
  const time = last ? formatRelativeTime(last.createdAt, locale) : null;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'group relative flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-all',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          selected
            ? 'bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(22,163,74,0.15)]'
            : 'hover:bg-white hover:shadow-[0_1px_2px_rgba(0,0,0,0.03)]',
        )}
      >
        {selected ? (
          <span
            aria-hidden="true"
            className="absolute left-0 top-3 h-8 w-0.5 rounded-r-full bg-brand-600"
          />
        ) : null}
        <ContactAvatar phone={conv.phone} state={conv.state} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate font-[family-name:var(--font-conv-mono)] text-[13px] font-medium tabular-nums text-neutral-900">
              {formatPhoneShort(conv.phone)}
            </p>
            {time ? (
              <span className="shrink-0 font-[family-name:var(--font-conv-mono)] text-[10.5px] tabular-nums text-neutral-400">
                {time}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            {last?.direction === 'OUT' ? (
              <span
                aria-label={t('outbound')}
                className="shrink-0 text-[10px] text-neutral-400"
              >
                ↗
              </span>
            ) : null}
            <p className="truncate text-[12.5px] leading-snug text-neutral-500">
              {last?.body ?? '—'}
            </p>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <StateBadge state={conv.state} t={t} />
            {conv.state === 'NEEDS_HUMAN' ? (
              <span className="font-[family-name:var(--font-conv-mono)] text-[10px] font-medium uppercase tracking-wide text-amber-700">
                {t('needsAttention')}
              </span>
            ) : null}
          </div>
        </div>
      </button>
    </li>
  );
}

function ContactAvatar({
  phone,
  state,
  size,
}: {
  phone: string;
  state: ConvState;
  size: 'md' | 'lg';
}) {
  const initials = getPhoneInitials(phone);
  const dim = size === 'lg' ? 'h-11 w-11 text-[13px]' : 'h-9 w-9 text-[11px]';
  return (
    <div className="relative shrink-0">
      <div
        className={cn(
          'flex items-center justify-center rounded-full font-[family-name:var(--font-conv-mono)] font-semibold tabular-nums text-neutral-700',
          'bg-gradient-to-br from-neutral-100 to-neutral-200',
          dim,
        )}
      >
        {initials}
      </div>
      <StateDot
        state={state}
        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 ring-2 ring-white"
      />
    </div>
  );
}

function StateDot({
  state,
  className,
}: {
  state: ConvState;
  className?: string;
}) {
  const map: Record<ConvState, string> = {
    BOT: 'bg-slate-400',
    NEEDS_HUMAN:
      'bg-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.18)] animate-pulse',
    HUMAN: 'bg-brand-600 shadow-[0_0_0_3px_rgba(22,163,74,0.15)]',
  };
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-2 w-2 rounded-full', map[state], className)}
    />
  );
}

function StateBadge({
  state,
  t,
}: {
  state: ConvState;
  t: ReturnType<typeof useTranslations<'panel.conversations'>>;
}) {
  const styles: Record<ConvState, string> = {
    BOT: 'bg-slate-100 text-slate-600 border-slate-200/60',
    NEEDS_HUMAN: 'bg-amber-50 text-amber-800 border-amber-200/70',
    HUMAN: 'bg-brand-50 text-brand-700 border-brand-200/70',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-[10px] font-medium',
        styles[state],
      )}
    >
      {t(`state.${state}`)}
    </span>
  );
}

function ConversationSkeletons() {
  return (
    <ul className="space-y-1 px-1 pt-1">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li
          key={i}
          className="flex items-start gap-3 rounded-lg px-2.5 py-2.5"
        >
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-8" />
            </div>
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-2/3" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyList({
  search,
  t,
}: {
  search: string;
  t: ReturnType<typeof useTranslations<'panel.conversations'>>;
}) {
  const isSearching = search.trim().length > 0;
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-100">
        {isSearching ? (
          <Search className="h-6 w-6 text-neutral-400" aria-hidden="true" />
        ) : (
          <Inbox className="h-6 w-6 text-neutral-400" aria-hidden="true" />
        )}
      </div>
      <p className="mt-3 font-[family-name:var(--font-conv-display)] text-[15px] text-neutral-700">
        {isSearching ? t('noResults') : t('emptyList')}
      </p>
      {isSearching ? (
        <p className="mt-1 text-[12px] text-neutral-500">
          {t('noResultsHint', { query: search })}
        </p>
      ) : null}
    </div>
  );
}

function EmptyChat({
  t,
}: {
  t: ReturnType<typeof useTranslations<'panel.conversations'>>;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="relative">
        <div className="absolute inset-0 -z-10 rounded-full bg-brand-500/5 blur-2xl" />
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-neutral-200/70 bg-white shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
          <MessageSquareText
            className="h-7 w-7 text-brand-600"
            aria-hidden="true"
          />
        </div>
      </div>
      <h2 className="mt-6 font-[family-name:var(--font-conv-display)] text-[22px] font-medium tracking-tight text-neutral-800">
        {t('emptyDetailTitle')}
      </h2>
      <p className="mt-2 max-w-xs text-[13px] leading-relaxed text-neutral-500">
        {t('emptyDetail')}
      </p>
    </div>
  );
}

function ChatSkeleton() {
  return (
    <>
      <header className="flex items-center gap-3 border-b border-neutral-200/70 px-6 py-4">
        <Skeleton className="h-11 w-11 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-8 w-20" />
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-hidden px-8 py-8">
        {[0, 1, 2, 3].map((i) => (
          <MessageBubbleSkeleton key={i} inbound={i % 2 === 0} />
        ))}
      </div>
    </>
  );
}

function MessageBubbleSkeleton({ inbound }: { inbound: boolean }) {
  return (
    <div className={cn('flex', inbound ? 'justify-start' : 'justify-end')}>
      <Skeleton
        className={cn(
          'h-14 rounded-2xl',
          inbound ? 'w-[55%] rounded-bl-md' : 'w-[45%] rounded-br-md',
        )}
      />
    </div>
  );
}

function MessageBubble({
  message,
  locale,
  showTimestamp,
}: {
  message: Message;
  locale: string;
  showTimestamp: boolean;
}) {
  const isIn = message.direction === 'IN';
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(message.createdAt));

  return (
    <div
      className={cn(
        'flex animate-in fade-in slide-in-from-bottom-1 duration-200',
        isIn ? 'justify-start' : 'justify-end',
      )}
    >
      <div
        className={cn(
          'max-w-[78%] px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words shadow-[0_1px_2px_rgba(0,0,0,0.04)]',
          isIn
            ? 'rounded-2xl rounded-bl-md border border-neutral-200/70 bg-white text-neutral-900'
            : 'rounded-2xl rounded-br-md bg-brand-600 text-white',
        )}
      >
        <p>{message.body}</p>
        {showTimestamp ? (
          <p
            className={cn(
              'mt-1 font-[family-name:var(--font-conv-mono)] text-[10px] tabular-nums',
              isIn ? 'text-neutral-400' : 'text-white/70',
            )}
          >
            {time}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function renderMessagesWithSeparators(messages: Message[], locale: string) {
  const nodes: React.ReactNode[] = [];
  let lastDay = '';
  const dayFmt = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  messages.forEach((m, i) => {
    const d = new Date(m.createdAt);
    const dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      nodes.push(
        <div
          key={`sep-${dayKey}`}
          className="my-2 flex items-center gap-3 text-[11px] font-medium text-neutral-400"
        >
          <span className="h-px flex-1 bg-neutral-200/60" />
          <span className="capitalize">{dayFmt.format(d)}</span>
          <span className="h-px flex-1 bg-neutral-200/60" />
        </div>,
      );
    }
    const next = messages[i + 1];
    const showTimestamp =
      !next ||
      next.direction !== m.direction ||
      new Date(next.createdAt).getTime() - d.getTime() > 60_000;
    nodes.push(
      <MessageBubble
        key={m.id}
        message={m}
        locale={locale}
        showTimestamp={showTimestamp}
      />,
    );
  });
  return nodes;
}

function ContactPanel({
  detail,
  locale,
  t,
}: {
  detail: ConversationDetail;
  locale: string;
  t: ReturnType<typeof useTranslations<'panel.conversations'>>;
}) {
  const created = new Date(detail.createdAt);
  const lastAt = new Date(detail.updatedAt);
  const dtFmt = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const waPhone = detail.phone.replace(/[^0-9]/g, '');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="border-b border-neutral-200/70 px-5 pt-6 pb-4">
        <p className="font-[family-name:var(--font-conv-display)] text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
          {t('contactPanelTitle')}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Identidad */}
        <div className="border-b border-neutral-200/70 px-5 py-5">
          <div className="flex items-center gap-3">
            <ContactAvatar
              phone={detail.phone}
              state={detail.state}
              size="lg"
            />
            <div className="min-w-0">
              <p className="truncate font-[family-name:var(--font-conv-display)] text-[16px] font-medium text-neutral-900">
                {formatPhone(detail.phone)}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-neutral-500">
                <UserRound className="h-3 w-3" aria-hidden="true" />
                {t('unknownContact')}
              </p>
            </div>
          </div>
          <a
            href={`https://wa.me/${waPhone}`}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[12.5px] font-medium text-neutral-700 shadow-[0_1px_2px_rgba(0,0,0,0.03)]',
              'transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-800',
            )}
          >
            <Phone className="h-3.5 w-3.5" aria-hidden="true" />
            {t('openInWhatsApp')}
            <ExternalLink className="h-3 w-3 opacity-60" aria-hidden="true" />
          </a>
        </div>

        {/* Estado */}
        <div className="border-b border-neutral-200/70 px-5 py-5">
          <p className="font-[family-name:var(--font-conv-display)] text-[10.5px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
            {t('sectionState')}
          </p>
          <div className="mt-3 flex items-center gap-2.5">
            <StateDot state={detail.state} className="h-2.5 w-2.5" />
            <p className="text-[13px] font-medium text-neutral-800">
              {t(`state.${detail.state}`)}
            </p>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-neutral-500">
            {t(`stateDescription.${detail.state}`)}
          </p>
        </div>

        {/* Actividad */}
        <div className="border-b border-neutral-200/70 px-5 py-5">
          <p className="font-[family-name:var(--font-conv-display)] text-[10.5px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
            {t('sectionActivity')}
          </p>
          <dl className="mt-3 space-y-2.5 text-[12.5px]">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-500">{t('firstSeen')}</dt>
              <dd className="font-[family-name:var(--font-conv-mono)] text-right tabular-nums text-neutral-700">
                {dtFmt.format(created)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-500">{t('lastMessageAt')}</dt>
              <dd className="font-[family-name:var(--font-conv-mono)] text-right tabular-nums text-neutral-700">
                {dtFmt.format(lastAt)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-500">{t('totalMessages')}</dt>
              <dd className="font-[family-name:var(--font-conv-mono)] tabular-nums text-neutral-700">
                {detail.messageCount}
              </dd>
            </div>
          </dl>
        </div>

        {/* Placeholder futuras integraciones */}
        <div className="px-5 py-5">
          <p className="font-[family-name:var(--font-conv-display)] text-[10.5px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
            {t('sectionAppointments')}
          </p>
          <div className="mt-3 rounded-lg border border-dashed border-neutral-300 bg-white/50 px-3 py-4 text-center">
            <p className="text-[12px] text-neutral-500">{t('comingSoon')}</p>
          </div>
        </div>
      </div>

      {/* Footer con chatId */}
      <div className="border-t border-neutral-200/70 px-5 py-3">
        <p className="flex items-center justify-between gap-2 font-[family-name:var(--font-conv-mono)] text-[10.5px] text-neutral-400">
          <span className="uppercase tracking-wider">chat</span>
          <span className="truncate tabular-nums">{detail.chatId}</span>
        </p>
      </div>
    </div>
  );
}

function ContactPanelEmpty({
  t,
}: {
  t: ReturnType<typeof useTranslations<'panel.conversations'>>;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/70">
        <MessageCircle
          className="h-5 w-5 text-neutral-400"
          aria-hidden="true"
        />
      </div>
      <p className="mt-3 max-w-[220px] text-[12px] leading-relaxed text-neutral-500">
        {t('contactPanelEmpty')}
      </p>
      <ChevronRight
        aria-hidden="true"
        className="mt-4 h-4 w-4 rotate-180 text-neutral-300"
      />
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════ */
/*  Helpers                                                                   */
/* ═════════════════════════════════════════════════════════════════════════ */

/**
 * Formatea "5491135551234" → "+54 9 11 3555 1234" (fallback: agrega + adelante
 * si empieza con dígito). No pretende ser libphonenumber-perfect — solo mejorar
 * legibilidad.
 */
function formatPhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 8) return raw;
  // Argentina: 54 9 [area] [num]
  if (digits.startsWith('549') && digits.length >= 12) {
    const rest = digits.slice(3);
    return `+54 9 ${rest.slice(0, 2)} ${rest.slice(2, 6)} ${rest.slice(6)}`;
  }
  if (digits.startsWith('55') && digits.length >= 12) {
    const rest = digits.slice(2);
    return `+55 ${rest.slice(0, 2)} ${rest.slice(2, 7)}-${rest.slice(7)}`;
  }
  return `+${digits}`;
}

/** Versión compacta para la lista (últimos 4-6 dígitos + prefijo corto). */
function formatPhoneShort(raw: string): string {
  const d = raw.replace(/[^0-9]/g, '');
  if (d.length < 8) return raw;
  if (d.length >= 12) return `+${d.slice(0, 2)} … ${d.slice(-6)}`;
  return `+${d}`;
}

/** Iniciales del teléfono para el avatar — últimos 2 dígitos. */
function getPhoneInitials(raw: string): string {
  const d = raw.replace(/[^0-9]/g, '');
  return d.slice(-2) || '··';
}

/** "hace 3m" / "2h" / "ayer" / "12 abr" — versión ligera. */
function formatRelativeTime(iso: string, locale: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60_000);
  const h = Math.floor(min / 60);
  const day = Math.floor(h / 24);
  if (min < 1) return 'ahora';
  if (min < 60) return `${min}m`;
  if (h < 24) return `${h}h`;
  if (day < 2) return locale.startsWith('pt') ? 'ontem' : 'ayer';
  if (day < 7) return `${day}d`;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
  }).format(d);
}
