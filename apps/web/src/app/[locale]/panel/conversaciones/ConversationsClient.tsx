'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ExternalLink,
  Inbox,
  Loader2,
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
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

type ConvState = 'BOT' | 'NEEDS_HUMAN' | 'HUMAN';

export interface ConversationListItem {
  id: string;
  chatId: string;
  // `phone` puede ser null cuando el contacto llegó con LID (privacidad WA).
  phone: string | null;
  lid: string | null;
  contactName: string | null;
  avatarUrl: string | null;
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
 * Bandeja del panel — split view (lista | chat | contacto) inscrito en el
 * lenguaje visual del panel (mismos tokens que Agenda: `rounded-xl border
 * border-border bg-card shadow-sm`, tipografía system, colores semánticos).
 *
 * Responsive:
 *   - < lg: una columna; al seleccionar conversación se muestra el chat con
 *     botón "volver" hacia la lista.
 *   - lg: dos columnas (lista + chat).
 *   - xl+: tres columnas (lista + chat + panel de contacto).
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

  const filteredConvos = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return convos;
    return convos.filter(
      (c) =>
        (c.contactName ?? '').toLowerCase().includes(q) ||
        (c.phone ?? '').toLowerCase().includes(q) ||
        (c.lastMessage?.body ?? '').toLowerCase().includes(q),
    );
  }, [convos, search]);

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

  useEffect(() => {
    if (!detail) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.messages.length, detail]);

  const onComposerKey = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void sendReply();
      }
    },
    [sendReply],
  );

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [reply]);

  return (
    <div
      className={cn(
        'grid h-full min-h-0 gap-4',
        'grid-cols-1 lg:grid-cols-[320px_1fr] xl:grid-cols-[320px_1fr_320px]',
      )}
    >
      {/* ═════════════ COLUMNA IZQUIERDA — BANDEJA ═════════════ */}
      <aside
        className={cn(
          'flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm',
          selectedId ? 'hidden lg:flex' : 'flex',
        )}
      >
        {/* Toolbar: buscador + estado polling */}
        <div className="flex items-center gap-2 border-b border-border/60 p-3">
          <div className="relative flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchInputRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="h-9 pl-8 pr-14 text-sm"
            />
            <kbd
              aria-hidden="true"
              className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 items-center rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-flex"
            >
              ⌘K
            </kbd>
          </div>
          <div className="flex h-9 items-center px-1">
            {refreshing ? (
              <Loader2
                aria-label={t('refreshing')}
                className="h-3.5 w-3.5 animate-spin text-muted-foreground"
              />
            ) : (
              <span
                aria-hidden="true"
                title={t('live')}
                className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]"
              />
            )}
          </div>
        </div>

        {/* Filtros — Tabs de shadcn como en Agenda */}
        <div className="border-b border-border/60 px-3 py-2">
          <Tabs value={stateFilter} onValueChange={setStateFilter}>
            <TabsList className="h-9 w-full">
              {(['inbox', 'BOT', 'HUMAN', 'all'] as const).map((s) => {
                const n = counts[s];
                return (
                  <TabsTrigger
                    key={s}
                    value={s}
                    className="flex-1 gap-1.5 px-2 text-xs"
                  >
                    <span>{t(`filters.${s}`)}</span>
                    {n > 0 ? (
                      <span
                        className={cn(
                          'rounded px-1 text-[10px] tabular-nums',
                          stateFilter === s
                            ? 'bg-brand-100 text-brand-700'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {n}
                      </span>
                    ) : null}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </div>

        {/* Lista */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {initialError && convos.length === 0 ? (
            <div className="m-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {t('loadError', { status: initialError })}
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

      {/* ═════════════ COLUMNA CENTRAL — CHAT ═════════════ */}
      <section
        className={cn(
          'flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm',
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
            <header className="flex items-center gap-3 border-b border-border/60 p-4">
              {selectedId ? (
                <button
                  type="button"
                  aria-label={t('backToList')}
                  onClick={() => setSelectedId(null)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted lg:hidden"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
              <ContactAvatar
                phone={detail.phone}
                contactName={detail.contactName}
                avatarUrl={detail.avatarUrl}
                state={detail.state}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-foreground">
                  {displayName(detail)}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {detail.phone && detail.contactName ? (
                    <>
                      <span className="tabular-nums">{formatPhone(detail.phone)}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  ) : null}
                  <StateDot state={detail.state} />
                  <span>{t(`state.${detail.state}`)}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">
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
              className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4"
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
            <footer className="border-t border-border/60 p-3">
              <div className="mx-auto max-w-3xl">
                <div className="rounded-lg border border-border bg-background transition-shadow focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
                  <Textarea
                    ref={composerRef}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={onComposerKey}
                    placeholder={t('replyPlaceholder')}
                    maxLength={MAX_REPLY_LEN}
                    rows={1}
                    className="min-h-[52px] resize-none border-0 bg-transparent px-3 py-2.5 text-sm shadow-none focus-visible:ring-0"
                    aria-describedby={
                      detail.state !== 'HUMAN' ? 'reply-hint' : undefined
                    }
                  />
                  <div className="flex items-center justify-between gap-3 border-t border-border/60 px-2.5 py-2">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      {detail.state !== 'HUMAN' ? (
                        <span
                          id="reply-hint"
                          role="note"
                          className="inline-flex items-center gap-1.5 rounded-md bg-amber-100/70 px-2 py-1 text-amber-800"
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
                            'text-[11px] tabular-nums',
                            reply.length > MAX_REPLY_LEN - 100
                              ? 'text-destructive'
                              : 'text-muted-foreground',
                          )}
                        >
                          {reply.length}/{MAX_REPLY_LEN}
                        </span>
                      ) : null}
                      <kbd
                        aria-hidden="true"
                        className="hidden items-center rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-flex"
                      >
                        ⌘↵
                      </kbd>
                      <Button
                        size="sm"
                        disabled={replying || !reply.trim()}
                        onClick={sendReply}
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

      {/* ═════════════ COLUMNA DERECHA — DETALLE CONTACTO (xl+) ═════════════ */}
      <aside className="hidden min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm xl:flex">
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
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'group relative flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected
            ? 'bg-brand-50 text-foreground'
            : 'hover:bg-accent hover:text-accent-foreground',
        )}
      >
        {selected ? (
          <span
            aria-hidden="true"
            className="absolute left-0 top-2.5 h-8 w-0.5 rounded-r-full bg-brand-600"
          />
        ) : null}
        <ContactAvatar
          phone={conv.phone}
          contactName={conv.contactName}
          avatarUrl={conv.avatarUrl}
          state={conv.state}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-medium text-foreground">
              {conv.contactName?.trim()
                ? conv.contactName
                : conv.phone
                  ? formatPhoneShort(conv.phone)
                  : 'Contacto WhatsApp'}
            </p>
            {time ? (
              <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                {time}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
            {last?.direction === 'OUT' ? (
              <span aria-label={t('outbound')} className="text-[10px]">
                ↗
              </span>
            ) : null}
            <span className="truncate">{last?.body ?? '—'}</span>
          </p>
          <div className="mt-1 flex items-center gap-1.5">
            <StateBadge state={conv.state} t={t} />
            {conv.state === 'NEEDS_HUMAN' ? (
              <span className="text-[10px] font-medium uppercase tracking-wide text-amber-700">
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
  contactName,
  avatarUrl,
  state,
  size,
}: {
  phone: string | null;
  contactName: string | null;
  avatarUrl: string | null;
  state: ConvState;
  size: 'md' | 'lg';
}) {
  const initials = getContactInitials({ contactName, phone });
  const dim = size === 'lg' ? 'h-10 w-10 text-xs' : 'h-9 w-9 text-[11px]';
  // Las URLs de perfil de WhatsApp expiran (~48h) y pueden dar 403. Usamos
  // <img> nativo + onError para caer a iniciales sin romper el layout.
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = avatarUrl && !imgFailed;
  return (
    <div className="relative shrink-0">
      <div
        className={cn(
          'flex items-center justify-center overflow-hidden rounded-full bg-muted font-semibold tabular-nums text-foreground',
          dim,
        )}
      >
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
          />
        ) : (
          initials
        )}
      </div>
      <StateDot
        state={state}
        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 ring-2 ring-card"
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
      'bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.18)] animate-pulse',
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
    BOT: 'bg-slate-100 text-slate-700 border-slate-200',
    NEEDS_HUMAN: 'bg-amber-50 text-amber-800 border-amber-200',
    HUMAN: 'bg-brand-50 text-brand-700 border-brand-200',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium',
        styles[state],
      )}
    >
      {t(`state.${state}`)}
    </span>
  );
}

function ConversationSkeletons() {
  return (
    <ul className="space-y-1 p-1">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i} className="flex items-start gap-2.5 rounded-md px-2 py-2">
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
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-4 py-10 text-center">
      <div className="rounded-full bg-muted p-3">
        {isSearching ? (
          <Search className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        ) : (
          <Inbox className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">
        {isSearching ? t('noResults') : t('emptyList')}
      </p>
      {isSearching ? (
        <p className="mt-1 text-xs text-muted-foreground">
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
    <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
      <div className="rounded-full bg-muted p-3">
        <MessageSquareText
          className="h-6 w-6 text-muted-foreground"
          aria-hidden="true"
        />
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">
        {t('emptyDetailTitle')}
      </p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        {t('emptyDetail')}
      </p>
    </div>
  );
}

function ChatSkeleton() {
  return (
    <>
      <header className="flex items-center gap-3 border-b border-border/60 p-4">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-8 w-20" />
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-hidden p-6">
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
    <div className={cn('flex', isIn ? 'justify-start' : 'justify-end')}>
      <div
        className={cn(
          'max-w-[78%] whitespace-pre-wrap break-words px-3.5 py-2.5 text-sm leading-relaxed shadow-sm',
          isIn
            ? 'rounded-2xl rounded-bl-md border border-border bg-card text-foreground'
            : 'rounded-2xl rounded-br-md bg-brand-600 text-white',
        )}
      >
        <p>{message.body}</p>
        {showTimestamp ? (
          <p
            className={cn(
              'mt-1 text-[10px] tabular-nums',
              isIn ? 'text-muted-foreground' : 'text-white/75',
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
          className="my-2 flex items-center gap-3 text-[11px] font-medium text-muted-foreground"
        >
          <Separator className="flex-1" />
          <span className="capitalize">{dayFmt.format(d)}</span>
          <Separator className="flex-1" />
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
  // wa.me solo funciona con phone real. Cuando el contacto llegó con LID
  // (@lid), no lo conocemos → escondemos el botón de "Abrir en WhatsApp".
  const waPhone = detail.phone ? detail.phone.replace(/[^0-9]/g, '') : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border/60 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('contactPanelTitle')}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Identidad */}
        <section className="border-b border-border/60 p-4">
          <div className="flex items-center gap-3">
            <ContactAvatar
              phone={detail.phone}
              contactName={detail.contactName}
              avatarUrl={detail.avatarUrl}
              state={detail.state}
              size="lg"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {displayName(detail)}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <UserRound className="h-3 w-3" aria-hidden="true" />
                {detail.phone
                  ? formatPhone(detail.phone)
                  : t('unknownContact')}
              </p>
            </div>
          </div>
          {waPhone ? (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="mt-3 w-full justify-center gap-1.5"
            >
              <a
                href={`https://wa.me/${waPhone}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                {t('openInWhatsApp')}
                <ExternalLink
                  className="h-3 w-3 opacity-60"
                  aria-hidden="true"
                />
              </a>
            </Button>
          ) : null}
        </section>

        {/* Estado */}
        <section className="border-b border-border/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('sectionState')}
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <StateDot state={detail.state} className="h-2.5 w-2.5" />
            <p className="text-sm font-medium text-foreground">
              {t(`state.${detail.state}`)}
            </p>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {t(`stateDescription.${detail.state}`)}
          </p>
        </section>

        {/* Actividad */}
        <section className="border-b border-border/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('sectionActivity')}
          </p>
          <dl className="mt-2.5 space-y-2 text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{t('firstSeen')}</dt>
              <dd className="text-right tabular-nums text-foreground">
                {dtFmt.format(created)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{t('lastMessageAt')}</dt>
              <dd className="text-right tabular-nums text-foreground">
                {dtFmt.format(lastAt)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{t('totalMessages')}</dt>
              <dd className="tabular-nums text-foreground">
                {detail.messageCount}
              </dd>
            </div>
          </dl>
        </section>

        {/* Citas relacionadas (placeholder) */}
        <section className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('sectionAppointments')}
          </p>
          <div className="mt-2.5 rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-center">
            <p className="text-xs text-muted-foreground">{t('comingSoon')}</p>
          </div>
        </section>
      </div>

      <footer className="border-t border-border/60 p-3">
        <p className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
          <span className="uppercase tracking-wider">chat</span>
          <span className="truncate tabular-nums">{detail.chatId}</span>
        </p>
      </footer>
    </div>
  );
}

function ContactPanelEmpty({
  t,
}: {
  t: ReturnType<typeof useTranslations<'panel.conversations'>>;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="rounded-full bg-muted p-3">
        <UserRound
          className="h-5 w-5 text-muted-foreground"
          aria-hidden="true"
        />
      </div>
      <p className="mt-3 max-w-[220px] text-xs leading-relaxed text-muted-foreground">
        {t('contactPanelEmpty')}
      </p>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════ */
/*  Helpers                                                                   */
/* ═════════════════════════════════════════════════════════════════════════ */

/**
 * Nombre visible para un contacto. Preferencia:
 *   1) pushName de WhatsApp (contactName)
 *   2) phone formateado (si lo conocemos)
 *   3) fallback genérico "Contacto WhatsApp"
 * Nunca devolvemos el LID pelado al usuario (número random sin significado).
 */
function displayName(conv: {
  contactName: string | null;
  phone: string | null;
}): string {
  if (conv.contactName && conv.contactName.trim()) return conv.contactName;
  if (conv.phone) return formatPhone(conv.phone);
  return 'Contacto WhatsApp';
}

/** Iniciales para el avatar: del nombre si existe, sino de los últimos 2 del phone. */
function getContactInitials(conv: {
  contactName: string | null;
  phone: string | null;
}): string {
  const name = conv.contactName?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  }
  if (conv.phone) return getPhoneInitials(conv.phone);
  return '··';
}

/**
 * Formatea "5491135551234" → "+54 9 11 3555 1234" (fallback: agrega + adelante
 * si empieza con dígito). No pretende ser libphonenumber-perfect — solo mejorar
 * legibilidad. Cubre AR (54 9) y BR (55) que son las clínicas objetivo.
 */
function formatPhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 8) return raw;
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

function formatPhoneShort(raw: string): string {
  const d = raw.replace(/[^0-9]/g, '');
  if (d.length < 8) return raw;
  if (d.length >= 12) return `+${d.slice(0, 2)} … ${d.slice(-6)}`;
  return `+${d}`;
}

function getPhoneInitials(raw: string): string {
  const d = raw.replace(/[^0-9]/g, '');
  return d.slice(-2) || '··';
}

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
